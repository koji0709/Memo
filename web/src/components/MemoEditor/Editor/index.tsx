import { last } from "lodash-es";
// Ensure getCaretCoordinates is imported
import getCaretCoordinates from "textarea-caret";
import { forwardRef, ReactNode, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { markdownServiceClient } from "@/grpcweb";
// Updated import to include Node type
import { Node, NodeType, OrderedListItemNode, TaskListItemNode, UnorderedListItemNode } from "@/types/proto/api/v1/markdown_service";
import { cn } from "@/utils";
import TagSuggestions from "./TagSuggestions";

export interface EditorRefActions {
  getEditor: () => HTMLTextAreaElement | null;
  focus: FunctionType;
  scrollToCursor: FunctionType;
  insertText: (text: string, prefix?: string, suffix?: string) => void;
  removeText: (start: number, length: number) => void;
  setContent: (text: string) => void;
  getContent: () => string;
  getSelectedContent: () => string;
  getCursorPosition: () => number;
  setCursorPosition: (startPos: number, endPos?: number) => void;
  getCursorLineNumber: () => number;
  getLine: (lineNumber: number) => string;
  setLine: (lineNumber: number, text: string) => void;
}

// Ensure SlashCommandUpdateParams interface is defined and exported
export interface SlashCommandUpdateParams {
  show: boolean;
  query: string;
  position?: { top: number; left: number; height: number };
  keyEvent?: React.KeyboardEvent<HTMLTextAreaElement>;
}

interface Props {
  className: string;
  initialContent: string;
  placeholder: string;
  tools?: ReactNode;
  onContentChange: (content: string) => void;
  onPaste: (event: React.ClipboardEvent) => void;
  // Callback for slash command updates
  onSlashCommandUpdate?: (params: SlashCommandUpdateParams) => void;
}

const Editor = forwardRef(function Editor(props: Props, ref: React.ForwardedRef<EditorRefActions>) {
  const {
    className,
    initialContent,
    placeholder,
    onPaste,
    onContentChange: handleContentChangeCallback,
    onSlashCommandUpdate, // Destructure the new prop
  } = props;
  const [isInIME, setIsInIME] = useState(false);
  // Removed local state for showSlashCommands and slashCommandQuery
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editorRef.current && initialContent) {
      editorRef.current.value = initialContent;
      handleContentChangeCallback(initialContent);
    }
  }, []);

  useEffect(() => {
    if (editorRef.current) {
      updateEditorHeight();
    }
  }, [editorRef.current?.value]);

  const editorActions = {
    getEditor: () => {
      return editorRef.current;
    },
    focus: () => {
      editorRef.current?.focus();
    },
    scrollToCursor: () => {
      if (editorRef.current) {
        editorRef.current.scrollTop = editorRef.current.scrollHeight;
      }
    },
    insertText: (content = "", prefix = "", suffix = "") => {
      if (!editorRef.current) {
        return;
      }

      const cursorPosition = editorRef.current.selectionStart;
      const endPosition = editorRef.current.selectionEnd;
      const prevValue = editorRef.current.value;
      const value =
        prevValue.slice(0, cursorPosition) +
        prefix +
        (content || prevValue.slice(cursorPosition, endPosition)) +
        suffix +
        prevValue.slice(endPosition);

      editorRef.current.value = value;
      editorRef.current.focus();
      // Adjust cursor position after insertion
      const newCursorPos = cursorPosition + prefix.length + content.length;
      editorRef.current.setSelectionRange(newCursorPos, newCursorPos);
      handleContentChangeCallback(editorRef.current.value);
      updateEditorHeight();
    },
    removeText: (start: number, length: number) => {
      if (!editorRef.current) {
        return;
      }

      const prevValue = editorRef.current.value;
      const value = prevValue.slice(0, start) + prevValue.slice(start + length);
      editorRef.current.value = value;
      editorRef.current.focus();
      editorRef.current.selectionEnd = start; // Set cursor position after removal
      handleContentChangeCallback(editorRef.current.value);
      updateEditorHeight();
    },
    setContent: (text: string) => {
      if (editorRef.current) {
        editorRef.current.value = text;
        handleContentChangeCallback(editorRef.current.value);
        updateEditorHeight();
      }
    },
    getContent: (): string => {
      return editorRef.current?.value ?? "";
    },
    getCursorPosition: (): number => {
      return editorRef.current?.selectionStart ?? 0;
    },
    getSelectedContent: () => {
      const start = editorRef.current?.selectionStart;
      const end = editorRef.current?.selectionEnd;
      return editorRef.current?.value.slice(start, end) ?? "";
    },
    setCursorPosition: (startPos: number, endPos?: number) => {
      const _endPos = isNaN(endPos as number) ? startPos : (endPos as number);
      editorRef.current?.setSelectionRange(startPos, _endPos);
    },
    getCursorLineNumber: () => {
      const cursorPosition = editorRef.current?.selectionStart ?? 0;
      const lines = editorRef.current?.value.slice(0, cursorPosition).split("\n") ?? [];
      return lines.length - 1;
    },
    getLine: (lineNumber: number) => {
      return editorRef.current?.value.split("\n")[lineNumber] ?? "";
    },
    setLine: (lineNumber: number, text: string) => {
      const lines = editorRef.current?.value.split("\n") ?? [];
      lines[lineNumber] = text;
      if (editorRef.current) {
        editorRef.current.value = lines.join("\n");
        editorRef.current.focus();
        handleContentChangeCallback(editorRef.current.value);
        updateEditorHeight();
      }
    },
  };

  useImperativeHandle(ref, () => editorActions, []);

  const updateEditorHeight = () => {
    if (editorRef.current) {
      editorRef.current.style.height = "auto";
      editorRef.current.style.height = (editorRef.current.scrollHeight ?? 0) + "px";
    }
  };

  const handleEditorInput = useCallback(() => {
    const currentContent = editorRef.current?.value ?? "";
    handleContentChangeCallback(currentContent);
    updateEditorHeight();

    // Slash command detection logic
    const editor = editorRef.current;
    if (editor && onSlashCommandUpdate) { // Check if callback exists
      const cursorPos = editor.selectionStart;
      const textBeforeCursor = currentContent.substring(0, cursorPos);
      // Check the text immediately before the cursor on the current line
      const currentLineStart = textBeforeCursor.lastIndexOf('\n') + 1;
      const currentLineTextBeforeCursor = textBeforeCursor.substring(currentLineStart);
      // Regex to match slash command trigger: / followed by zero or more non-space characters, at the end of the line segment
      const slashMatch = currentLineTextBeforeCursor.match(/\/(\S*)$/);

      // Only trigger if the pattern matches and the cursor is right after the query
      if (slashMatch && editor.selectionEnd === cursorPos) {
        const query = slashMatch[1];
        // Calculate caret position for the suggestion box
        const position = getCaretCoordinates(editor, cursorPos);
        onSlashCommandUpdate({ show: true, query, position });
      } else {
        // If no match or cursor moved, tell parent to hide suggestions
        onSlashCommandUpdate({ show: false, query: "" });
      }
    }
  }, [handleContentChangeCallback, onSlashCommandUpdate]); // Added dependencies

  // Adjusted getLastNode to handle potential undefined children (safer)
  const getLastNode = (nodes: Node[]): Node | undefined => {
    const lastNode = last(nodes);
    if (!lastNode) {
      return undefined;
    }
    // Check if it's a list node and has children before recursing
    if (lastNode.type === NodeType.LIST && lastNode.listNode?.children && lastNode.listNode.children.length > 0) {
        return getLastNode(lastNode.listNode.children);
    }
    return lastNode;
  };


  const handleEditorKeyDown = async (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle keydown for slash commands if suggestions might be shown
    const isSlashCommandKey = ["ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"].includes(event.key);
    if (isSlashCommandKey && onSlashCommandUpdate) {
      // Let the parent know about the key event.
      // The parent will check if suggestions are visible and decide whether to preventDefault.
      onSlashCommandUpdate({ show: true, query: "", keyEvent: event }); // Pass the key event

      // If the parent component handled the event (e.g., navigated suggestions, selected one, or closed on Esc),
      // it should call event.preventDefault(). We check that here to stop further processing.
      if (event.defaultPrevented) {
        return;
      }
    }

    // --- Original Enter key logic for list continuation ---
    if (event.key === "Enter" && !isInIME) {
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
        // Allow Shift+Enter etc. for newlines without list continuation
        return;
      }

      const cursorPosition = editorActions.getCursorPosition();
      const prevContent = editorActions.getContent().substring(0, cursorPosition);

      // Existing list continuation logic...
      // Need to handle potential errors from parseMarkdown
      try {
        const { nodes } = await markdownServiceClient.parseMarkdown({ markdown: prevContent });
        const lastNode = getLastNode(nodes); // Use the safer getLastNode
        if (!lastNode) {
          // If no valid previous node for list continuation, allow default Enter (newline)
          return;
        }

        // Get the indentation of the previous line
        const lines = prevContent.split("\n");
        const lastLine = lines[lines.length - 1];
        const indentationMatch = lastLine.match(/^\s*/);
        let insertText = indentationMatch ? indentationMatch[0] : ""; // Keep the indentation of the previous line
        let didInsertListSyntax = false;

        // Check node types before accessing specific node properties
        if (lastNode.type === NodeType.TASK_LIST_ITEM && lastNode.taskListItemNode) {
          const { symbol } = lastNode.taskListItemNode;
          insertText += `${symbol} [ ] `;
          didInsertListSyntax = true;
        } else if (lastNode.type === NodeType.UNORDERED_LIST_ITEM && lastNode.unorderedListItemNode) {
          const { symbol } = lastNode.unorderedListItemNode;
          insertText += `${symbol} `;
          didInsertListSyntax = true;
        } else if (lastNode.type === NodeType.ORDERED_LIST_ITEM && lastNode.orderedListItemNode) {
          const { number } = lastNode.orderedListItemNode;
          insertText += `${Number(number) + 1}. `;
          didInsertListSyntax = true;
        }

        if (didInsertListSyntax) { // Only insert if we added list syntax
          editorActions.insertText(insertText);
          event.preventDefault(); // Prevent default Enter behavior ONLY if we inserted list syntax
        }
        // If we didn't insert list syntax, we DON'T preventDefault, allowing a normal newline.
      } catch (error) {
         console.error("Error parsing markdown for list continuation:", error);
         // Allow default Enter behavior on error
      }
    }
  };

  return (
    <div
      className={cn("flex flex-col justify-start items-start relative w-full h-auto max-h-[50vh] bg-inherit dark:text-gray-300", className)}
    >
      <textarea
        className="w-full h-full my-1 text-base resize-none overflow-x-hidden overflow-y-auto bg-transparent outline-none whitespace-pre-wrap word-break"
        rows={1}
        placeholder={placeholder}
        ref={editorRef}
        onPaste={onPaste}
        onInput={handleEditorInput}
        onKeyDown={handleEditorKeyDown}
        onCompositionStart={() => setIsInIME(true)}
        onCompositionEnd={() => setTimeout(() => setIsInIME(false))}
      ></textarea>
      <TagSuggestions editorRef={editorRef} editorActions={ref} />
    </div>
  );
});

export default Editor;
