# Validate the result, not just the markup

Name the user journey and the expected outcome. Use existing application tests and a working preview; browser_session serves static files only. Discover an appropriate managed runtime for backend applications.

At representative narrow and wide viewport sizes, inspect hierarchy, alignment, type legibility, spacing, content order and overflow. Use a screenshot/vision tool only if advertised, or an actual supplied screenshot. Browser text snapshots can validate labels and content, but cannot establish visual quality. Do not invent a screenshot review.

Exercise the primary action, navigation, form validation and recovery. Check loading/empty/error states using fixtures or supported controls. Verify keyboard focus order, visible focus, accessible control names and a way to recover from mistakes. Automated checks help but do not prove full accessibility or usability.

Use WCAG's relevant criteria for contrast, reflow, keyboard access, focus visibility and target size; verify measurements with available tools. Do not guess contrast ratios. Test long text and realistic content, not only ideal short placeholders.

Compare the rendered result with the stated design intent. Report what improved, what was exercised, and what needs visual review or real-user feedback. Re-run only checks affected by the next design change.

References: https://www.w3.org/WAI/WCAG22/quickref/ and https://www.nngroup.com/articles/ten-usability-heuristics/
