# Find bugs
Look for bugs in {{#selection}}the selected code in {{/selection}}`{{file}}`: edge cases, null/undefined handling, async race conditions, lost reactivity, incorrect watchers, and off-by-one errors. Only report real issues, each with a short reproduction and a fix.

{{#selection}}
```{{language}}
{{selection}}
```
{{/selection}}
