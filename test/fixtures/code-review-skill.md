---
name: code-review
description: Review a project for code quality issues, run tests, and generate a report
---

# Code Review Skill

Perform a code review on the current project.

## Steps

1. Discover the project structure — list source files, identify the language and build system
2. Check if a test command exists (look for package.json scripts, Makefile, etc.)
3. If tests exist, run them
4. If tests pass, proceed to code review. If tests fail, report the failures and stop.
5. Read the main source files (not node_modules, not generated files)
6. Review the code for:
   - Unused imports or variables
   - Missing error handling
   - Potential security issues (hardcoded secrets, unsafe eval, etc.)
   - Code style inconsistencies
7. Generate a summary report with findings and severity levels (info, warning, error)
