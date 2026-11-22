"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.render = render;
/**
 * Renders {{var}} placeholders. Sections {{#var}}...{{/var}} are kept only when var is non-empty,
 * and {{^var}}...{{/var}} only when it is empty.
 */
function render(template, vars) {
    let out = template.replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_m, kind, name, inner) => {
        const has = (vars[name] ?? '').trim().length > 0;
        return (kind === '#' ? has : !has) ? inner : '';
    });
    out = out.replace(/\{\{(\w+)\}\}/g, (_m, name) => vars[name] ?? '');
    return out.replace(/\n{3,}/g, '\n\n').trim();
}
//# sourceMappingURL=template.js.map