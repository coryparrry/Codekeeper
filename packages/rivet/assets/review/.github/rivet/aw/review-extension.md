---
engine:
  mcp:
    tool-timeout: 4m
pre-agent-steps:
  - name: Record Rivet authority receipt
    id: rivet-authority
    uses: ./.github/rivet/actions/authority-receipt
    with:
      workflow-id: rivet-review
      compiler-version: v0.86.2
      workflow-ref: ${{ github.workflow_ref }}
      workflow-sha: ${{ github.workflow_sha }}
---

## Native Rivet extension proof

Prefer findings that identify the smallest observable failure and its affected boundary.
