// AUDIT_RECHECK_2026-05-21 P1 closure: this subtree is a TypeScript
// project. A stub go.mod here marks it as its own Go module so that
// `go list ./...` from the repo root never descends into npm-managed
// node_modules content (which can contain incidental .go files such
// as `node_modules/flatted/golang/pkg/flatted/flatted.go`).
//
// No Go source actually compiles under this module — it exists purely
// as a discovery boundary.
module github.com/AccumulateNetwork/infrix-vscode-tools-isolated

go 1.25
