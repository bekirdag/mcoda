---
name: ui-ux-design
description: "Design or improve web/app UI and UX: user flows, visual hierarchy, typography, responsive layouts and accessible interactions."
---

Start with the user's task, audience, primary action and success state. Inspect existing screens, components, design tokens and product constraints. Preserve the established brand and explicit preferences. Separate observed usability problems from assumptions; a request for polish does not authorize replacing the product or its architecture.

For a new screen, define a coherent visual direction: hierarchy, type scale, spacing rhythm, color roles, content density and reusable components. For an existing screen, fix the strongest problems first and reuse its design system. Make primary actions and important information easy to find. Use decoration and motion purposefully; do not apply the same fashionable template to every product.

Map the main journey and navigation before styling details. Use familiar labels, readable content, clear feedback and recoverable errors. Cover empty, loading, success, error and disabled states. Prevent accidental destructive actions without adding friction to routine actions. Keep form input when validation fails.

Design responsive behavior explicitly: narrow/wide layouts, wrapping, overflow and touch targets. Include semantic controls, keyboard operation, visible focus, labels, contrast and reduced-motion behavior. Check the applicable accessibility criteria rather than asserting compliance from appearance.

For implementation, follow code-implementation and existing components. For validation, read references/validation.md and use webapp-testing/browser tools that are actually available. Inspect the rendered journey and visual output where possible; text snapshots alone cannot prove spacing, color or visual polish. Test representative API payloads and user roles: render named fields instead of raw objects, and ensure CSS does not override role-dependent hidden states. Inspect actual browser visibility, not markup alone. Report unverified visual/accessibility checks honestly.

Sources: https://www.nngroup.com/articles/ten-usability-heuristics/ and https://www.w3.org/WAI/WCAG22/quickref/. Original Codali adaptation.
