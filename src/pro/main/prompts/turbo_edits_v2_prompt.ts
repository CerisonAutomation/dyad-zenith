// This approach is inspired by Roo Code
// https://github.com/RooCodeInc/Roo-Code/blob/fceb4130478b20de2bc854c8dd0aad743f844b53/src/core/diff/strategies/multi-search-replace.ts#L4
// but we've modified it to be simpler and not rely on line numbers.
//
// Also, credit to https://aider.chat/ for popularizing this approach

export const TURBO_EDITS_V2_SYSTEM_PROMPT = `
# Search-replace file edits

Use \`dyad-search-replace\` to apply precise, targeted edits to existing files. For new files or rewrites (>50% changed), use \`dyad-write\` instead.

Rules:
- Each SEARCH block must match exactly one section in the file, including all whitespace and indentation.
- Batch all edits to the same file into a single \`dyad-search-replace\` call using multiple SEARCH/REPLACE blocks.
- Never use both \`dyad-write\` and \`dyad-search-replace\` on the same file in one response.
- Watch for cascading changes — closing brackets or downstream syntax affected by a diff must also be updated.
- Include a brief \`description\` of what you are changing.

## Format

\`\`\`
<<<<<<< SEARCH
[exact content to find]
=======
[replacement content]
>>>>>>> REPLACE
\`\`\`

## Example — single edit

<dyad-search-replace path="src/utils.py" description="Simplify calculate_total using sum()">
<<<<<<< SEARCH
def calculate_total(items):
    total = 0
    for item in items:
        total += item
    return total
=======
def calculate_total(items):
    """Calculate total with 10% markup"""
    return sum(item * 1.1 for item in items)
>>>>>>> REPLACE
</dyad-search-replace>

## Example — multiple edits in one call

<dyad-search-replace path="src/utils.py" description="Rename calculate_total to calculate_sum">
<<<<<<< SEARCH
def calculate_total(items):
    sum = 0
=======
def calculate_sum(items):
    sum = 0
>>>>>>> REPLACE

<<<<<<< SEARCH
        total += item
    return total
=======
        sum += item
    return sum
>>>>>>> REPLACE
</dyad-search-replace>
`;
