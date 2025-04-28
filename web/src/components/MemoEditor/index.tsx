import { Select, Option, Divider } from "@mui/joy";
import { Button } from "@usememos/mui";
import { isEqual } from "lodash-es";
import { LoaderIcon, SendIcon } from "lucide-react";
// Added `useCallback` for the effect dependency
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { toast } from "react-hot-toast";
import { useTranslation } from "react-i18next";
import useLocalStorage from "react-use/lib/useLocalStorage";
import { memoServiceClient } from "@/grpcweb";
import { TAB_SPACE_WIDTH } from "@/helpers/consts";
import { isValidUrl } from "@/helpers/utils";
import useAsyncEffect from "@/hooks/useAsyncEffect";
import useCurrentUser from "@/hooks/useCurrentUser";
import { useMemoStore, useResourceStore, useUserStore, useWorkspaceSettingStore } from "@/store/v1";
import { MemoRelation, MemoRelation_Type } from "@/types/proto/api/v1/memo_relation_service";
import { Location, Memo, Visibility } from "@/types/proto/api/v1/memo_service";
import { Resource } from "@/types/proto/api/v1/resource_service";
import { UserSetting } from "@/types/proto/api/v1/user_service";
import { WorkspaceMemoRelatedSetting } from "@/types/proto/api/v1/workspace_setting_service";
import { WorkspaceSettingKey } from "@/types/proto/store/workspace_setting";
import { useTranslate } from "@/utils/i18n";
import { convertVisibilityFromString, convertVisibilityToString } from "@/utils/memo";
import VisibilityIcon from "../VisibilityIcon";
import AddMemoRelationPopover from "./ActionButton/AddMemoRelationPopover";
import LocationSelector from "./ActionButton/LocationSelector";
import MarkdownMenu from "./ActionButton/MarkdownMenu";
import TagSelector from "./ActionButton/TagSelector";
import UploadResourceButton from "./ActionButton/UploadResourceButton";
import Editor, { EditorRefActions } from "./Editor";
// Import the type for the callback parameters
import { SlashCommandUpdateParams } from "./Editor";
import SlashCommandSuggestions from "./SlashCommandSuggestions"; // Assuming we create this component
import RelationListView from "./RelationListView";
import ResourceListView from "./ResourceListView";
import { handleEditorKeydownWithMarkdownShortcuts, hyperlinkHighlightedText } from "./handlers";
import { MemoEditorContext } from "./types";


export interface Props {
  className?: string;
  cacheKey?: string;
  placeholder?: string;
  // The name of the memo to be edited.
  memoName?: string;
  // The name of the parent memo if the memo is a comment.
  parentMemoName?: string;
  autoFocus?: boolean;
  onConfirm?: (memoName: string) => void;
  onCancel?: () => void;
}

// Define command structure type
interface SlashCommand {
  command: string;
  label: string;
  description?: string; // Made optional
  actionPrefix?: string;
  actionSuffix?: string;
  // Add other action types if needed, e.g., a function to call
}

interface State {
  memoVisibility: Visibility;
  resourceList: Resource[];
  relationList: MemoRelation[];
  location: Location | undefined;
  isUploadingResource: boolean;
  isRequesting: boolean;
  isComposing: boolean;
  // State for slash commands (v0.24.0 didn't have isDraggingFile)
  showSlashSuggestions: boolean;
  slashQuery: string;
  suggestionsPosition: { top: number; left: number; height: number } | null;
  filteredCommands: SlashCommand[]; // Use the defined type
  selectedSuggestionIndex: number;
}

// Define available commands outside the component or memoize it
const availableCommands: SlashCommand[] = [
  { command: 'todo', label: 'Todo List', description: 'Create a checklist item', actionPrefix: '- [ ] ' },
  { command: 'h1', label: 'Heading 1', description: 'Large section heading', actionPrefix: '# ' },
  { command: 'h2', label: 'Heading 2', description: 'Medium section heading', actionPrefix: '## ' },
  { command: 'h3', label: 'Heading 3', description: 'Small section heading', actionPrefix: '### ' },
  { command: 'ul', label: 'Bulleted List', description: 'Create a bulleted list', actionPrefix: '- ' },
  // { command: 'ol', label: 'Numbered List', description: 'Create a numbered list', actionPrefix: '1. ' }, // Removed Numbered List
  { command: 'quote', label: 'Quote', description: 'Capture a quote', actionPrefix: '> ' },
  { command: 'code', label: 'Code Block', description: 'Capture a code snippet', actionPrefix: '```\n', actionSuffix: '\n```' },
  // Add more commands as needed
];

const MemoEditor = (props: Props) => {
  const { className, cacheKey, memoName, parentMemoName, autoFocus, onConfirm, onCancel } = props;
  const t = useTranslate();
  const { i18n } = useTranslation();
  const workspaceSettingStore = useWorkspaceSettingStore();
  const userStore = useUserStore();
  const memoStore = useMemoStore();
  const resourceStore = useResourceStore();
  const currentUser = useCurrentUser();
  const [state, setState] = useState<State>({
    memoVisibility: Visibility.PRIVATE,
    resourceList: [],
    relationList: [],
    location: undefined,
    isUploadingResource: false,
    isRequesting: false,
    isComposing: false,
    // Initialize slash command state
    showSlashSuggestions: false,
    slashQuery: "",
    suggestionsPosition: null,
    filteredCommands: [],
    selectedSuggestionIndex: 0,
  });
  const [displayTime, setDisplayTime] = useState<Date | undefined>();
  const [hasContent, setHasContent] = useState<boolean>(false);
  const editorRef = useRef<EditorRefActions>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null); // Ref for the main container
  const userSetting = userStore.userSetting as UserSetting;
  const contentCacheKey = `${currentUser.name}-${cacheKey || ""}`;
  const [contentCache, setContentCache] = useLocalStorage<string>(contentCacheKey, "");
  const referenceRelations = memoName
    ? state.relationList.filter(
        (relation) =>
          relation.memo?.name === memoName && relation.relatedMemo?.name !== memoName && relation.type === MemoRelation_Type.REFERENCE,
      )
    : state.relationList.filter((relation) => relation.type === MemoRelation_Type.REFERENCE);
  const workspaceMemoRelatedSetting =
    workspaceSettingStore.getWorkspaceSettingByKey(WorkspaceSettingKey.MEMO_RELATED)?.memoRelatedSetting ||
    WorkspaceMemoRelatedSetting.fromPartial({});

  // Effect to handle clicks outside the editor to close suggestions
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // If suggestions are shown and the click target is outside the editor container
      if (state.showSlashSuggestions && editorContainerRef.current && !editorContainerRef.current.contains(event.target as Node)) {
        setState(s => ({ ...s, showSlashSuggestions: false }));
      }
    };

    // Add listener when suggestions are shown
    if (state.showSlashSuggestions) {
      document.addEventListener('mousedown', handleClickOutside);
    } else {
      // Remove listener when suggestions are hidden
      document.removeEventListener('mousedown', handleClickOutside);
    }

    // Cleanup listener on component unmount
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [state.showSlashSuggestions]); // Rerun effect when showSlashSuggestions changes


  useEffect(() => {
    editorRef.current?.setContent(contentCache || "");
  }, []);

  useEffect(() => {
    if (autoFocus) {
      handleEditorFocus();
    }
  }, [autoFocus]);

  useEffect(() => {
    let visibility = userSetting.memoVisibility;
    if (workspaceMemoRelatedSetting.disallowPublicVisibility && visibility === "PUBLIC") {
      visibility = "PRIVATE";
    }
    setState((prevState) => ({
      ...prevState,
      memoVisibility: convertVisibilityFromString(visibility),
    }));
  }, [userSetting.memoVisibility, workspaceMemoRelatedSetting.disallowPublicVisibility]);

  useAsyncEffect(async () => {
    if (!memoName) {
      return;
    }

    const memo = await memoStore.getOrFetchMemoByName(memoName);
    if (memo) {
      handleEditorFocus();
      setDisplayTime(memo.displayTime);
      setState((prevState) => ({
        ...prevState,
        memoVisibility: memo.visibility,
        resourceList: memo.resources,
        relationList: memo.relations,
        location: memo.location,
      }));
      if (!contentCache) {
        editorRef.current?.setContent(memo.content ?? "");
      }
    }
  }, [memoName]);

  const handleCompositionStart = () => {
    setState((prevState) => ({
      ...prevState,
      isComposing: true,
    }));
  };

  const handleCompositionEnd = () => {
    setState((prevState) => ({
      ...prevState,
      isComposing: false,
    }));
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
     // Prevent slash command key handling here if suggestions are shown
    // The Editor component's onSlashCommandUpdate will handle it first
    if (state.showSlashSuggestions && ["ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"].includes(event.key)) {
        // Let the callback handle prevention
        return;
    }

    if (!editorRef.current) {
      return;
    }

    const isMetaKey = event.ctrlKey || event.metaKey;
    if (isMetaKey) {
      if (event.key === "Enter") {
        void handleSaveBtnClick();
        return;
      }
      if (!workspaceMemoRelatedSetting.disableMarkdownShortcuts) {
        handleEditorKeydownWithMarkdownShortcuts(event, editorRef.current);
      }
    }
    if (event.key === "Tab" && !state.isComposing) {
      event.preventDefault();
      const tabSpace = " ".repeat(TAB_SPACE_WIDTH);
      const cursorPosition = editorRef.current.getCursorPosition();
      const selectedContent = editorRef.current.getSelectedContent();
      editorRef.current.insertText(tabSpace);
      if (selectedContent) {
        editorRef.current.setCursorPosition(cursorPosition + TAB_SPACE_WIDTH);
      }
      return;
    }
  };

  const handleMemoVisibilityChange = (visibility: Visibility) => {
    setState((prevState) => ({
      ...prevState,
      memoVisibility: visibility,
    }));
  };

  const handleSetResourceList = (resourceList: Resource[]) => {
    setState((prevState) => ({
      ...prevState,
      resourceList,
    }));
  };

  const handleSetRelationList = (relationList: MemoRelation[]) => {
    setState((prevState) => ({
      ...prevState,
      relationList,
    }));
  };

  const handleUploadResource = async (file: File) => {
    setState((state) => {
      return {
        ...state,
        isUploadingResource: true,
      };
    });

    const { name: filename, size, type } = file;
    const buffer = new Uint8Array(await file.arrayBuffer());

    try {
      const resource = await resourceStore.createResource({
        resource: Resource.fromPartial({
          filename,
          size,
          type,
          content: buffer,
        }),
      });
      setState((state) => {
        return {
          ...state,
          isUploadingResource: false,
        };
      });
      return resource;
    } catch (error: any) {
      console.error(error);
      toast.error(error.details);
    } finally {
       // Ensure uploading state is reset even on error
       setState((state) => ({ ...state, isUploadingResource: false }));
    }
  };


  const uploadMultiFiles = async (files: FileList) => {
    const uploadedResourceList: Resource[] = [];
    for (const file of files) {
      const resource = await handleUploadResource(file);
      if (resource) {
        uploadedResourceList.push(resource);
        if (memoName) {
          await resourceStore.updateResource({
            resource: Resource.fromPartial({
              name: resource.name,
              memo: memoName,
            }),
            updateMask: ["memo"],
          });
        }
      }
    }
    if (uploadedResourceList.length > 0) {
      setState((prevState) => ({
        ...prevState,
        resourceList: [...prevState.resourceList, ...uploadedResourceList],
      }));
    }
  };

  const handleDropEvent = async (event: React.DragEvent) => {
    if (event.dataTransfer && event.dataTransfer.files.length > 0) {
      event.preventDefault();
      await uploadMultiFiles(event.dataTransfer.files);
    }
  };

  const handlePasteEvent = async (event: React.ClipboardEvent) => {
    if (event.clipboardData && event.clipboardData.files.length > 0) {
      event.preventDefault();
      await uploadMultiFiles(event.clipboardData.files);
    } else if (
      editorRef.current != null &&
      editorRef.current.getSelectedContent().length != 0 &&
      isValidUrl(event.clipboardData.getData("Text"))
    ) {
      event.preventDefault();
      hyperlinkHighlightedText(editorRef.current, event.clipboardData.getData("Text"));
    }
  };

  const handleContentChange = (content: string) => {
    setHasContent(content !== "");
    if (content !== "") {
      setContentCache(content);
    } else {
      localStorage.removeItem(contentCacheKey);
    }
  };

  const handleSaveBtnClick = async () => {
    if (state.isRequesting) {
      return;
    }

    setState((state) => {
      return {
        ...state,
        isRequesting: true,
      };
    });
    const content = editorRef.current?.getContent() ?? "";
    try {
      // Update memo.
      if (memoName) {
        const prevMemo = await memoStore.getOrFetchMemoByName(memoName);
        if (prevMemo) {
          const updateMask = new Set<string>();
          const memoPatch: Partial<Memo> = {
            name: prevMemo.name,
            content,
          };
          if (!isEqual(content, prevMemo.content)) {
            updateMask.add("content");
            memoPatch.content = content;
          }
          if (!isEqual(state.memoVisibility, prevMemo.visibility)) {
            updateMask.add("visibility");
            memoPatch.visibility = state.memoVisibility;
          }
          if (!isEqual(state.resourceList, prevMemo.resources)) {
            updateMask.add("resources");
            memoPatch.resources = state.resourceList;
          }
          if (!isEqual(state.relationList, prevMemo.relations)) {
            updateMask.add("relations");
            memoPatch.relations = state.relationList;
          }
          if (!isEqual(state.location, prevMemo.location)) {
            updateMask.add("location");
            memoPatch.location = state.location;
          }
          if (["content", "resources", "relations", "location"].some((key) => updateMask.has(key))) {
            updateMask.add("update_time");
          }
          if (!isEqual(displayTime, prevMemo.displayTime)) {
            updateMask.add("display_time");
            memoPatch.displayTime = displayTime;
          }
          if (updateMask.size === 0) {
            toast.error("No changes detected");
            if (onCancel) {
              onCancel();
            }
            // Need to reset requesting state even if no changes
            setState((s) => ({ ...s, isRequesting: false }));
            return;
          }
          const memo = await memoStore.updateMemo(memoPatch, Array.from(updateMask));
          if (onConfirm) {
            onConfirm(memo.name);
          }
        }
      } else {
        // Create memo or memo comment.
        const request = !parentMemoName
          ? memoStore.createMemo({
              memo: Memo.fromPartial({
                content,
                visibility: state.memoVisibility,
                resources: state.resourceList,
                relations: state.relationList,
                location: state.location,
              }),
            })
          : memoServiceClient
              .createMemoComment({
                name: parentMemoName,
                comment: {
                  content,
                  visibility: state.memoVisibility,
                  resources: state.resourceList,
                  relations: state.relationList,
                  location: state.location,
                },
              })
              .then((memo) => memo);
        const memo = await request;
        if (onConfirm) {
          onConfirm(memo.name);
        }
      }
      editorRef.current?.setContent("");
    } catch (error: any) {
      console.error(error);
      toast.error(error.details);
    } finally {
        localStorage.removeItem(contentCacheKey);
        setState((s) => {
          return {
            ...s,
            isRequesting: false,
            resourceList: [],
            relationList: [],
            location: undefined,
            // Reset slash command state on save/error
            showSlashSuggestions: false,
            slashQuery: "",
            filteredCommands: [],
            selectedSuggestionIndex: 0,
          };
        });
    }
  };

  const handleCancelBtnClick = () => {
    localStorage.removeItem(contentCacheKey);
    setState(s => ({ ...s, showSlashSuggestions: false })); // Hide suggestions on cancel

    if (onCancel) {
      onCancel();
    }
  };

  const handleEditorFocus = () => {
    editorRef.current?.focus();
  };

  const editorConfig = useMemo(
    () => ({
      className: "",
      initialContent: "",
      placeholder: props.placeholder ?? t("editor.any-thoughts"),
      onContentChange: handleContentChange,
      onPaste: handlePasteEvent,
    }),
    [i18n.language],
  );

  // Callback function to handle updates from the Editor component regarding slash commands
  const handleSlashCommandUpdate = useCallback((params: SlashCommandUpdateParams) => {
    const { show, query, position, keyEvent } = params;

    if (!show) {
      // Only update state if suggestions are currently shown
      if (state.showSlashSuggestions) {
        setState(s => ({ ...s, showSlashSuggestions: false }));
      }
      return;
    }

    // Filter commands based on the query
    const lowerQuery = query.toLowerCase();
    const filtered = availableCommands.filter(cmd => cmd.command.toLowerCase().startsWith(lowerQuery));

    // Handle keyboard events for navigation/selection
    if (keyEvent) {
      // Only handle keys if suggestions are currently visible and there are commands to select
      if (state.showSlashSuggestions && filtered.length > 0) {
        let newIndex = state.selectedSuggestionIndex;
        let shouldPreventDefault = false; // Flag to track if we should prevent default

        if (keyEvent.key === "ArrowDown") {
          newIndex = (state.selectedSuggestionIndex + 1) % filtered.length;
          shouldPreventDefault = true;
        } else if (keyEvent.key === "ArrowUp") {
          newIndex = (state.selectedSuggestionIndex - 1 + filtered.length) % filtered.length;
          shouldPreventDefault = true;
        } else if (keyEvent.key === "Enter" || keyEvent.key === "Tab") {
          // Only prevent default if we actually execute a command
          if (state.filteredCommands[state.selectedSuggestionIndex]) {
            shouldPreventDefault = true;
            executeSlashCommand(state.filteredCommands[state.selectedSuggestionIndex]);
            // Hide suggestions after execution handled in executeSlashCommand
            keyEvent.preventDefault(); // Prevent default ONLY when executing command
            return; // Command executed
          }
        } else if (keyEvent.key === "Escape") {
          shouldPreventDefault = true;
          // Hide suggestions on escape
          setState(s => ({ ...s, showSlashSuggestions: false }));
          keyEvent.preventDefault(); // Prevent default for Escape
          return;
        }

        // Update selected index if changed
        if (newIndex !== state.selectedSuggestionIndex) {
            setState(s => ({ ...s, selectedSuggestionIndex: newIndex }));
        }
        // Prevent default if needed for navigation keys
        if (shouldPreventDefault) {
            keyEvent.preventDefault();
        }
      }
      // Removed the 'else if' block that handled Enter/Tab immediately after typing '/'
    } else {
      // Update state based on input change (no key event)
      // Only show if there are matches
      const shouldShow = filtered.length > 0;
      setState(s => ({
        ...s,
        showSlashSuggestions: shouldShow,
        slashQuery: query,
        filteredCommands: filtered,
        // Reset index only if query changes or suggestions are newly shown
        selectedSuggestionIndex: (s.slashQuery !== query || !s.showSlashSuggestions) ? 0 : s.selectedSuggestionIndex,
        // Update position only if suggestions are shown
        suggestionsPosition: shouldShow ? (position || s.suggestionsPosition) : null,
      }));
    }
  }, [state.showSlashSuggestions, state.selectedSuggestionIndex, state.filteredCommands, state.slashQuery]); // Added dependencies for the callback


  // Function to execute the selected slash command
  const executeSlashCommand = useCallback((command: SlashCommand | undefined) => {
    if (!editorRef.current || !command) return;

    const editor = editorRef.current.getEditor();
    if (!editor) return;

    const currentPos = editor.selectionStart;
    const textBefore = editor.value.substring(0, currentPos);
    // Find the start of the slash command we need to replace more reliably
    const commandStartPos = textBefore.lastIndexOf(`/${state.slashQuery}`);

    if (commandStartPos !== -1) {
      // Ensure we are replacing the correct thing
      const lengthToRemove = state.slashQuery.length + 1; // +1 for the '/'
      if (textBefore.substring(commandStartPos, commandStartPos + lengthToRemove) === `/${state.slashQuery}`) {
        editorRef.current.removeText(commandStartPos, lengthToRemove);
        // Insert the command's action prefix/suffix
        editorRef.current.insertText("", command.actionPrefix || "", command.actionSuffix || "");
        // Adjust cursor position after insertion
        const newCursorPos = commandStartPos + (command.actionPrefix?.length || 0);
        if (command.actionSuffix) {
           // If there's a suffix (like code block), place cursor between prefix and suffix
           editorRef.current.setCursorPosition(newCursorPos);
        } else {
           // Otherwise, place cursor after the prefix
           editorRef.current.setCursorPosition(newCursorPos);
        }
      }
    }
     // Hide suggestions after execution
     setState(s => ({ ...s, showSlashSuggestions: false }));
  }, [state.slashQuery]); // Added dependency


  const allowSave = (hasContent || state.resourceList.length > 0) && !state.isUploadingResource && !state.isRequesting;

  return (
    <MemoEditorContext.Provider
      value={{
        resourceList: state.resourceList,
        relationList: state.relationList,
        setResourceList: (resourceList: Resource[]) => {
          setState((prevState) => ({
            ...prevState,
            resourceList,
          }));
        },
        setRelationList: (relationList: MemoRelation[]) => {
          setState((prevState) => ({
            ...prevState,
            relationList,
          }));
        },
        memoName,
      }}
    >
      {/* Attach ref to the main container */}
      <div
        ref={editorContainerRef}
        className={`${
          className ?? ""
        } relative w-full flex flex-col justify-start items-start bg-white dark:bg-zinc-800 px-4 pt-4 rounded-lg border border-gray-200 dark:border-zinc-700`}
        tabIndex={0}
        onKeyDown={handleKeyDown} // Keep existing keydown handler
        onDrop={handleDropEvent}
        // Removed onFocus, onCompositionStart, onCompositionEnd from here as they should be handled by the textarea
      >
        {memoName && displayTime && (
          <DatePicker
            selected={displayTime}
            onChange={(date) => date && setDisplayTime(date)}
            showTimeSelect
            showMonthDropdown
            showYearDropdown
            yearDropdownItemNumber={5}
            dateFormatCalendar=" "
            customInput={<span className="cursor-pointer text-sm text-gray-400 dark:text-gray-500">{displayTime.toLocaleString()}</span>}
            calendarClassName="ml-24 sm:ml-44"
          />
        )}
        {/* Render Suggestions Box */}
        {state.showSlashSuggestions && state.suggestionsPosition && (
          <SlashCommandSuggestions
            position={state.suggestionsPosition}
            commands={state.filteredCommands}
            selectedIndex={state.selectedSuggestionIndex}
            // Pass execution function wrapped to handle potential undefined command
            onSelect={(cmd: SlashCommand) => executeSlashCommand(cmd)} // Added type SlashCommand
            onClose={() => setState(s => ({ ...s, showSlashSuggestions: false }))} // Allow closing via suggestion box itself
          />
        )}
        {/* Pass the callback to Editor */}
        <Editor
          ref={editorRef}
          {...editorConfig}
          onSlashCommandUpdate={handleSlashCommandUpdate}
          // Pass composition handlers to the underlying textarea via Editor props if needed, or handle within Editor itself
          // onCompositionStart={handleCompositionStart}
          // onCompositionEnd={handleCompositionEnd}
         />
        <ResourceListView resourceList={state.resourceList} setResourceList={handleSetResourceList} />
        <RelationListView relationList={referenceRelations} setRelationList={handleSetRelationList} />
        <div className="relative w-full flex flex-row justify-between items-center pt-2" onFocus={(e) => e.stopPropagation()}>
          <div className="flex flex-row justify-start items-center opacity-80 dark:opacity-60 -space-x-1">
            <TagSelector editorRef={editorRef} />
            <MarkdownMenu editorRef={editorRef} />
            {/* UploadResourceButton in v0.24.0 manages its own state */}
            <UploadResourceButton />
            <AddMemoRelationPopover editorRef={editorRef} />
            {workspaceMemoRelatedSetting.enableLocation && (
              <LocationSelector
                location={state.location}
                onChange={(location) =>
                  setState((prevState) => ({
                    ...prevState,
                    location,
                  }))
                }
              />
            )}
          </div>
        </div>
        <Divider className="!mt-2 opacity-40" />
        <div className="w-full flex flex-row justify-between items-center py-3 gap-2 overflow-auto dark:border-t-zinc-500">
          <div className="relative flex flex-row justify-start items-center" onFocus={(e) => e.stopPropagation()}>
            <Select
              className="!text-sm"
              variant="plain"
              size="md"
              value={state.memoVisibility}
              startDecorator={<VisibilityIcon visibility={state.memoVisibility} />}
              onChange={(_, visibility) => {
                if (visibility) {
                  handleMemoVisibilityChange(visibility);
                }
              }}
            >
              {[Visibility.PRIVATE, Visibility.PROTECTED, Visibility.PUBLIC].map((item) => (
                <Option key={item} value={item} className="whitespace-nowrap !text-sm">
                  {t(`memo.visibility.${convertVisibilityToString(item).toLowerCase()}` as any)}
                </Option>
              ))}
            </Select>
          </div>
          <div className="shrink-0 flex flex-row justify-end items-center gap-2">
            {props.onCancel && (
              <Button variant="plain" disabled={state.isRequesting} onClick={handleCancelBtnClick}>
                {t("common.cancel")}
              </Button>
            )}
            <Button color="primary" disabled={!allowSave || state.isRequesting} onClick={handleSaveBtnClick}>
              {t("editor.save")}
              {!state.isRequesting ? <SendIcon className="w-4 h-auto ml-1" /> : <LoaderIcon className="w-4 h-auto ml-1 animate-spin" />}
            </Button>
          </div>
        </div>
      </div>
    </MemoEditorContext.Provider>
  );
};

export default MemoEditor;
