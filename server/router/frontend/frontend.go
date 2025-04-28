package frontend

import (
	"context"
	"embed"
	"io/fs"
	"log/slog" // Added for logging
	"net/http"
	"os" // Added for checking directory existence
	"strings" // Added for path manipulation

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"

	"github.com/usememos/memos/internal/util"
	"github.com/usememos/memos/server/profile"
	"github.com/usememos/memos/store"
)

//go:embed dist/*
var embeddedFiles embed.FS

type FrontendService struct {
	Profile *profile.Profile
	Store   *store.Store
}

func NewFrontendService(profile *profile.Profile, store *store.Store) *FrontendService {
	return &FrontendService{
		Profile: profile,
		Store:   store,
	}
}

// Serve serves the frontend static files.
func (s *FrontendService) Serve(_ context.Context, e *echo.Echo) {
	// skipper defines paths to skip for static file serving (API routes).
	skipper := func(c echo.Context) bool {
		return util.HasPrefixes(c.Path(), "/api", "/memos.api.v1")
	}

	// Route to serve the assets folder without HTML5 fallback.
	// Assets are served with long cache headers.
	e.Group("/assets").Use(middleware.GzipWithConfig(middleware.GzipConfig{
		Level: 5,
	}), func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Response().Header().Set(echo.HeaderCacheControl, "public, max-age=31536000, immutable")
			return next(c)
		}
	}, middleware.StaticWithConfig(middleware.StaticConfig{
		Filesystem: s.getFileSystem("dist/assets"), // Use the modified getFileSystem
		HTML5:      false,                          // Disable fallback to index.html for assets
	}))

	// Route to serve the main app (index.html, etc.) with HTML5 fallback for SPA behavior.
	e.Use(middleware.StaticWithConfig(middleware.StaticConfig{
		Filesystem: s.getFileSystem("dist"), // Use the modified getFileSystem
		HTML5:      true,                    // Enable fallback to index.html
		Skipper:    skipper,                 // Skip API routes
	}))
}

// getFileSystem returns the appropriate http.FileSystem based on the run mode.
// In "dev" mode, it serves files directly from the "web/dist" directory structure.
// In "prod" mode (or any other mode), it serves files from the embedded filesystem.
func (s *FrontendService) getFileSystem(path string) http.FileSystem {
	if s.Profile.Mode == "dev" {
		// Base path for frontend build output in development
		webDistPath := "web/dist"
		// Determine the actual directory to serve based on the requested path prefix
		servePath := webDistPath // Default to serving the root for HTML5 fallback

		// If the request is specifically for assets (path starts with "dist/assets"),
		// construct the correct path relative to the project root.
		if strings.HasPrefix(path, "dist/assets") {
			servePath = webDistPath + "/assets"
		}

		slog.Info("Serving frontend files from directory", slog.String("requested_path", path), slog.String("serving_path", servePath))

		// Check if the calculated serve path exists
		_, err := os.Stat(servePath)
		if os.IsNotExist(err) {
			// Log an error if the directory doesn't exist, as assets are likely missing.
			slog.Error("Frontend directory not found. Please build frontend assets first.", "path", servePath, "error", err, "command", "`cd web && pnpm install && pnpm build`")
			// Return a dummy filesystem that will likely cause 404s, making the issue visible.
			// Returning the base 'web/dist' might mask the issue for asset requests due to HTML5 fallback later.
			// Returning '.' ensures asset requests will 404 clearly if web/dist/assets is missing.
			if strings.HasPrefix(path, "dist/assets") {
				return http.Dir(".") // Cause 404 for missing assets
			}
			// For the main path "dist", still return web/dist for potential index.html serving
			return http.Dir(webDistPath)
		}

		// Return the correct directory based on the request.
		// For "/assets" group, return "web/dist/assets".
		// For the main SPA group, return "web/dist".
		if strings.HasPrefix(path, "dist/assets") {
			return http.Dir(servePath) // Serve specific assets path
		}
		return http.Dir(webDistPath) // Serve base path for SPA routing

	}

	// Production mode: serve from embedded files
	slog.Info("Serving frontend files from embedded filesystem", slog.String("path", path))
	embeddedPath := path
	fsys, err := fs.Sub(embeddedFiles, embeddedPath)
	if err != nil {
		slog.Error("Failed to get embedded filesystem", "path", embeddedPath, "error", err)
		// In prod mode, embedded files should exist. Panic if they don't.
		panic(err)
	}
	return http.FS(fsys)
}
