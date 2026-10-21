import { useEffect, useState } from 'react';

import { formatTime, parseTime } from '../media';

// A time field: shows the value, and accepts typed times (h:mm:ss.mmm, mm:ss or seconds). Enter or leaving the field applies it.
export default function TimeInput({ value, onChange, disabled, title, width = 108 }: {
  value: number | undefined,
  onChange: (t: number) => boolean | void,
  disabled?: boolean,
  title?: string,
  width?: number,
}) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState(false);

  useEffect(() => {
    setText(undefined);
    setError(false);
  }, [value]);

  const commit = () => {
    if (text == null) return;
    const t = parseTime(text);
    if (t == null || onChange(t) === false) {
      setError(true);
      return;
    }
    setText(undefined);
    setError(false);
  };

  return (
    <input
      className={`input mono${error ? ' error' : ''}`}
      style={{ width, textAlign: 'center', fontSize: '.85em', padding: '.3em .4em' }}
      disabled={disabled}
      title={title}
      value={text ?? (value != null ? formatTime(value) : '')}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          commit();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          setText(undefined);
          setError(false);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
