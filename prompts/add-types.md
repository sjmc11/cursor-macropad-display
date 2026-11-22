# Add TS types
Tighten the TypeScript types in {{#selection}}the selected code in {{/selection}}`{{file}}`: remove `any`, add explicit return types on exported functions, type props/emits properly with `defineProps`/`defineEmits` generics, and prefer narrow unions over strings. Don't change runtime behaviour.

{{#selection}}
```{{language}}
{{selection}}
```
{{/selection}}
