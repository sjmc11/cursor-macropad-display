export type TemplateVars = Record<string, string>;

/**
 * Renders {{var}} placeholders. Sections {{#var}}...{{/var}} are kept only when var is non-empty,
 * and {{^var}}...{{/var}} only when it is empty.
 */
export function render(template: string, vars: TemplateVars): string {
  let out = template.replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_m, kind: string, name: string, inner: string) => {
    const has = (vars[name] ?? '').trim().length > 0;
    return (kind === '#' ? has : !has) ? inner : '';
  });
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => vars[name] ?? '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
