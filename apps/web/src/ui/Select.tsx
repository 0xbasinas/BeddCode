import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import {
  Select as ShadSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

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

/** Radix items cannot have an empty value, so an empty option is carried under this one. */
const EMPTY = '\u0000empty'

/**
 * A stand-in for `<select>` built on shadcn's Select: takes `<option>` children like the native
 * element does, so call sites keep their `value` / `onChange` shape.
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
  const current = String(value ?? '')

  return (
    <ShadSelect
      value={current === '' ? EMPTY : current}
      disabled={disabled}
      onValueChange={(v) => onChange({ target: { value: v === EMPTY ? '' : v } })}
    >
      <SelectTrigger
        id={id}
        aria-label={rest['aria-label']}
        className={cn('select-trigger', className)}
      >
        <SelectValue>{options.find((o) => o.value === current)?.label ?? current}</SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="z-[60]">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value === '' ? EMPTY : o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </ShadSelect>
  )
}
