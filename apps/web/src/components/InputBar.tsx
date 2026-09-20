import { useState, type FormEvent, type KeyboardEvent } from 'react';

import styles from './InputBar.module.css';

interface InputBarProps {
  readonly onSubmit: (text: string) => void | Promise<void>;
  readonly disabled: boolean;
}

/**
 * Textarea + Send button. Enter submits (Shift+Enter for newline).
 * Disabled while a request is in flight — the Chat parent controls
 * the `pending` state.
 */
export function InputBar({ onSubmit, disabled }: InputBarProps) {
  const [text, setText] = useState('');

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    void onSubmit(trimmed);
    setText('');
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <textarea
        className={styles.textarea}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKey}
        placeholder="Ask something…"
        rows={2}
        disabled={disabled}
        aria-label="Ask a question"
      />
      <button
        type="submit"
        className={styles.sendButton}
        disabled={disabled || text.trim() === ''}
      >
        Send
      </button>
    </form>
  );
}
