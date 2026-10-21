import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Dropdown } from './Dropdown.tsx'

interface OptionProps {
  value?: string | number
  disabled?: boolean
  children?: ReactNode
}

interface SelectProps {
  value: string | number | undefined
  /** Same shape as a native select's change event, so existing handlers read `e.target.value`. */
  onChange(event: { target: { value: string } }): void
  children: ReactNode
  id?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

/**
 * A themed stand-in for `<select>`: native option lists ignore our styling, so this draws the
 * list with the app's own menu. Takes `<option>` children like the native element does.
 */
export function Select({
  value,
  onChange,
  children,
  id,
  disabled,
  className,
  ...rest
}: SelectProps) {
  const options = Children.toArray(children)
    .filter((c): c is ReactElement<OptionProps> => isValidElement(c))
    .map((c) => ({
      value: String(c.props.value ?? ''),
      label: c.props.children,
      disabled: c.props.disabled === true,
    }))
  const current = options.find((o) => o.value === String(value ?? ''))

  return (
    <Dropdown
      placement="bottom"
      align="end"
      panelClassName="select-menu"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          id={id}
          className={`select-trigger ${className ?? ''}`}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={rest['aria-label']}
          onClick={toggle}
        >
          <span className="select-value">{current?.label ?? String(value ?? '')}</span>
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) =>
        options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="menu-row"
            role="option"
            aria-selected={o.value === String(value)}
            disabled={o.disabled}
            onClick={() => {
              onChange({ target: { value: o.value } })
              close()
            }}
          >
            <span className="menu-text">
              <span className="menu-title">{o.label}</span>
            </span>
            {o.value === String(value) && <Check size={15} />}
          </button>
        ))
      }
    </Dropdown>
  )
}
