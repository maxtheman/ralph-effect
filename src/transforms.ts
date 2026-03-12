/**
 * transforms.ts — Built-in pipe transform factories.
 *
 * Transforms shape data as it flows through a pipe.
 * Each factory returns a PipeTransform: (text, metadata) => string
 */
import type { PipeTransform } from "./loop-types.js"

/** Truncate output to N characters */
export const truncate = (maxLength: number): PipeTransform =>
  (text) => text.slice(0, maxLength)

/** Extract only lines matching a regex pattern */
export const grepLines = (pattern: RegExp): PipeTransform =>
  (text) => text.split("\n").filter((l) => pattern.test(l)).join("\n")

/** Prefix output with pipe metadata */
export const withMetadata: PipeTransform = (text, meta) =>
  `[From: ${meta.from} | Iter: ${meta.iteration} | ${meta.trigger}]\n${text}`

/** Template string interpolation with {{placeholders}} */
export const template = (tmpl: string): PipeTransform =>
  (text, meta) =>
    tmpl
      .replace(/\{\{text\}\}/g, text)
      .replace(/\{\{from\}\}/g, meta.from)
      .replace(/\{\{to\}\}/g, meta.to)
      .replace(/\{\{iteration\}\}/g, String(meta.iteration))
      .replace(/\{\{trigger\}\}/g, meta.trigger)

/** Extract a JSON field from the output (if agent returns structured data) */
export const jsonField = (field: string): PipeTransform =>
  (text) => {
    try {
      const parsed = JSON.parse(text)
      return String(parsed[field] ?? text)
    } catch {
      return text
    }
  }

/** Chain multiple transforms in sequence */
export const chain = (...transforms: PipeTransform[]): PipeTransform =>
  (text, meta) => transforms.reduce((acc, t) => t(acc, meta), text)
