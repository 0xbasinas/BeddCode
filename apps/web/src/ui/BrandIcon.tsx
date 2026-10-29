import { useId } from 'react'
import { BRAND_ICONS, type BrandId } from './brandIconData.ts'

export type { BrandId }

export const isBrandId = (id: string | undefined): id is BrandId => !!id && id in BRAND_ICONS

/**
 * A product's logo from theSVG (see brandIconData.ts), drawn at a fixed square size. Monochrome
 * logos take the text colour; the rest keep their own colours. With a `label` it is announced as
 * an image, otherwise it is decorative and hidden from screen readers.
 */
export function BrandIcon({
  brand,
  size = 14,
  label,
  className = '',
}: {
  brand: BrandId
  size?: number
  label?: string
  className?: string
}) {
  const icon = BRAND_ICONS[brand] as (typeof BRAND_ICONS)[BrandId] & {
    fill?: string
    fillRule?: string
  }
  // useId gives ":r1:"-style ids; keep them valid inside url(#…).
  const prefix = `brand-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-`
  return (
    <svg
      className={`brand-icon brand-${brand} ${className}`}
      width={size}
      height={size}
      viewBox={icon.viewBox}
      fill={icon.fill}
      fillRule={icon.fillRule as 'evenodd' | 'nonzero' | undefined}
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      // Static markup generated from vendored SVG files, never from user input.
      dangerouslySetInnerHTML={{ __html: icon.body.replaceAll('__ID__', prefix) }}
    />
  )
}
