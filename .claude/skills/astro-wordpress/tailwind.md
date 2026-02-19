# Tailwind v4 Theming Guide

## Theme Tokens (theme.css)
Edit src/styles/theme.css:

```css
@theme {
    /* Colors - creates bg-primary, text-primary, border-primary, etc. */
    --color-primary: #6366f1;
    --color-primary-dark: #4f46e5;
    --color-primary-light: #818cf8;

    --color-surface: #ffffff;      /* Page background */
    --color-surface-alt: #f9fafb;  /* Card backgrounds */
    --color-content: #1f2937;      /* Main text */
    --color-content-light: #6b7280; /* Secondary text */
    --color-outline: #e5e7eb;      /* Borders */

    /* Fonts */
    --font-sans: 'Inter', system-ui, sans-serif;
    --font-mono: 'Fira Code', monospace;

    /* Spacing */
    --space-xs: 0.25rem;
    --space-sm: 0.5rem;
    --space-md: 1rem;
    --space-lg: 1.5rem;
}
```

## Dark Mode
Add dark mode variant with .dark class:
```css
.dark {
    --color-surface: #0f172a;
    --color-content: #f9fafb;
    /* ... other dark colors */
}
```

## Usage
```html
<div class="bg-surface text-content border-outline">
    <h1 class="text-primary">Title</h1>
    <p class="text-content-light">Subtitle</p>
    <button class="bg-primary text-white cursor-pointer">Click</button>
</div>
```
