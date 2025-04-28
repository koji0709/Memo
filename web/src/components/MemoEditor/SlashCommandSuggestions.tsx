import React from 'react';
import { cn } from '@/utils'; // Assuming cn utility exists

// Define the structure for a command passed to this component
// Ensure this matches the definition in MemoEditor/index.tsx
interface SlashCommand {
  command: string;
  label: string;
  description?: string; // Made optional to match MemoEditor
  // Add other relevant fields if needed
}

interface Props {
  position: { top: number; left: number; height: number };
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

const SlashCommandSuggestions: React.FC<Props> = ({ position, commands, selectedIndex, onSelect, onClose }) => {
  if (!commands || commands.length === 0) {
    return null; // Don't render if no commands match
  }

  // Basic styling - adjust as needed
  const style: React.CSSProperties = {
    position: 'absolute',
    top: position.top + position.height + 2, // Position below the caret line
    left: position.left,
    zIndex: 10, // Ensure it's above the editor
    maxHeight: '150px', // Limit height (Keep reduced height)
    overflowY: 'auto', // Allow scrolling
    background: 'white', // Or theme background
    border: '1px solid #ccc', // Or theme border
    borderRadius: '4px',
    boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
    minWidth: '200px', // Ensure minimum width
  };

  // Use effect to scroll the selected item into view
  const listRef = React.useRef<HTMLUListElement>(null);
  React.useEffect(() => {
    const selectedElement = listRef.current?.children[selectedIndex] as HTMLLIElement | undefined;
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);


  return (
    <div style={style} className="dark:bg-zinc-700 dark:border-zinc-600">
      <ul ref={listRef}>
        {commands.map((cmd, index) => (
          <li
            key={cmd.command}
            className={cn(
              // Reduced vertical padding (py-1), kept horizontal padding (px-2)
              "py-1 px-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-zinc-600",
              index === selectedIndex ? "bg-gray-200 dark:bg-zinc-500" : ""
            )}
            // Use onMouseDown to prevent editor blur before click registers
            onMouseDown={(e) => {
              e.preventDefault(); // Prevent editor blur
              onSelect(cmd);
            }}
          >
            {/* Reduced label font size */}
            <div className="font-medium text-sm dark:text-gray-100">{cmd.label}</div>
            {/* Reduced description font size */}
            {cmd.description && <div className="text-xs text-gray-500 dark:text-gray-400">{cmd.description}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
};

export default SlashCommandSuggestions;