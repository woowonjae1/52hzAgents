// Command gentypes writes the TypeScript declarations of the backend's JSON wire
// types to the frontend, so a response field the frontend misspells or a field
// the backend renames is a compile error rather than an `undefined` at runtime.
//
// The Go structs stay the source of truth: this reads their `json:"..."` tags
// with go/parser and emits one `export interface` per struct, following the
// rules encoding/json applies when it marshals them. It uses only the standard
// library so it runs on an offline machine.
//
// Run from workspace/backend:
//
//	go run ./cmd/gentypes
//
// gentypes_test.go fails when the committed file is out of date, and CI runs
// `go test ./...`, so a struct change without a regenerate does not merge.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// outputPath is where the declarations land, relative to workspace/backend.
const outputPath = "../frontend/lib/generated/api-types.ts"

// source is one Go package the generator reads.
type source struct {
	// dir is the package directory relative to workspace/backend.
	dir string
	// alias is the package's name as other packages' selectors spell it.
	alias string
	// roots lists the structs to emit. Nil means every exported struct.
	// Structs a root references in the same package are emitted as well,
	// exported or not, so a root never points at a type that does not exist.
	roots []string
}

// sources is the curated surface. models is emitted whole: every exported
// struct there is a table row that some handler returns. handlers is mostly
// internal plumbing, so only the request and response structs are listed.
var sources = []source{
	{dir: "internal/models", alias: "models"},
	{dir: "internal/handlers", alias: "handlers", roots: []string{
		// routing_parallel.go / parallel_run.go: GET /v1/parallel-batch
		"ParallelBatch",
		"ParallelWorker",
		"ScopeConflict",
		"ParallelRunView",
		// work_profiles.go: GET/POST/PATCH .../profiles
		"WorkProfilesResponse",
		"WorkProfileRequest",
		// agent_context.go: POST .../agents/:name/context
		"ReportAgentContextRequest",
		// agent_turns.go: POST .../agents/:name/turn
		"ReportAgentTurnRequest",
		// token_stats.go: GET .../tokens/stats
		"WorkspaceTokenStatsResponse",
		"AgentTokenStat",
		// activity.go: GET .../activity/commits, .../activity/turns
		"ActivityCommitsResponse",
		"ActivityTurnsResponse",
	}},
}

func main() {
	root := flag.String("root", ".", "workspace/backend directory")
	out := flag.String("out", "", "output file (default <root>/"+outputPath+")")
	flag.Parse()

	target := *out
	if target == "" {
		target = filepath.Join(*root, filepath.FromSlash(outputPath))
	}
	code, err := generate(*root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gentypes:", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "gentypes:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(target, code, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "gentypes:", err)
		os.Exit(1)
	}
	fmt.Println("gentypes: wrote", filepath.ToSlash(target))
}

// pkg is one parsed package: its type declarations and how each of its files
// names the packages it imports.
type pkg struct {
	alias string
	types map[string]*typeDecl
}

type typeDecl struct {
	name string
	spec *ast.TypeSpec
	doc  *ast.CommentGroup
	// imports maps the declaring file's local package names to import paths.
	imports map[string]string
}

// ref names one emitted struct: the package it lives in and its Go name.
type ref struct {
	pkg  string
	name string
}

type generator struct {
	pkgs map[string]*pkg // by alias
	emit map[ref]bool
	// tsName is the one TypeScript name every emitted struct gets.
	tsName map[ref]string
}

// generate parses the sources under root and returns the TypeScript file.
func generate(root string) ([]byte, error) {
	g := &generator{pkgs: map[string]*pkg{}, emit: map[ref]bool{}, tsName: map[ref]string{}}
	for _, src := range sources {
		p, err := parsePackage(filepath.Join(root, filepath.FromSlash(src.dir)), src.alias)
		if err != nil {
			return nil, err
		}
		g.pkgs[src.alias] = p
	}

	// Seed the roots, then close over same-package references.
	var queue []ref
	for _, src := range sources {
		p := g.pkgs[src.alias]
		if src.roots == nil {
			for name, decl := range p.types {
				if _, isStruct := decl.spec.Type.(*ast.StructType); isStruct && ast.IsExported(name) {
					queue = append(queue, ref{src.alias, name})
				}
			}
			continue
		}
		for _, name := range src.roots {
			decl, ok := p.types[name]
			if !ok {
				return nil, fmt.Errorf("%s: root type %s not found", src.dir, name)
			}
			if _, isStruct := decl.spec.Type.(*ast.StructType); !isStruct {
				return nil, fmt.Errorf("%s: root type %s is not a struct", src.dir, name)
			}
			queue = append(queue, ref{src.alias, name})
		}
	}
	for len(queue) > 0 {
		r := queue[0]
		queue = queue[1:]
		if g.emit[r] {
			continue
		}
		g.emit[r] = true
		queue = append(queue, g.references(r.pkg, g.pkgs[r.pkg].types[r.name], map[ref]bool{})...)
	}

	// One flat namespace on the TypeScript side: two packages exporting the
	// same name would silently merge into one interface, so refuse.
	refs := make([]ref, 0, len(g.emit))
	owner := map[string]ref{}
	for r := range g.emit {
		refs = append(refs, r)
		if prev, dup := owner[r.name]; dup {
			return nil, fmt.Errorf("type name %s is emitted from both %s and %s; rename one", r.name, prev.pkg, r.pkg)
		}
		owner[r.name] = r
		g.tsName[r] = r.name
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].name < refs[j].name })

	var b bytes.Buffer
	b.WriteString("// Code generated by cmd/gentypes. DO NOT EDIT.\n")
	b.WriteString("//\n")
	b.WriteString("// The JSON shapes the Go backend sends and accepts, read from the `json` tags\n")
	b.WriteString("// on its structs (workspace/backend/internal/models and the request/response\n")
	b.WriteString("// structs listed in cmd/gentypes). Regenerate after changing one of them:\n")
	b.WriteString("//\n")
	b.WriteString("//   npm run gen:types      (from workspace/frontend)\n")
	b.WriteString("//   go run ./cmd/gentypes  (from workspace/backend)\n")
	b.WriteString("//\n")
	b.WriteString("// These are wire types, snake_case as the server writes them. Map them into\n")
	b.WriteString("// the frontend's own camelCase types in lib/api rather than using them in UI.\n")
	for _, r := range refs {
		b.WriteString("\n")
		if err := g.writeInterface(&b, r); err != nil {
			return nil, err
		}
	}
	return b.Bytes(), nil
}

func parsePackage(dir, alias string) (*pkg, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	fset := token.NewFileSet()
	p := &pkg{alias: alias, types: map[string]*typeDecl{}}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.ParseComments)
		if err != nil {
			return nil, err
		}
		imports := map[string]string{}
		for _, imp := range file.Imports {
			path, _ := strconv.Unquote(imp.Path.Value)
			local := path[strings.LastIndex(path, "/")+1:]
			if imp.Name != nil {
				local = imp.Name.Name
			}
			imports[local] = path
		}
		for _, d := range file.Decls {
			gen, ok := d.(*ast.GenDecl)
			if !ok || gen.Tok != token.TYPE {
				continue
			}
			for _, s := range gen.Specs {
				spec := s.(*ast.TypeSpec)
				if spec.TypeParams != nil {
					continue // generic types have no single wire shape
				}
				doc := spec.Doc
				if doc == nil && len(gen.Specs) == 1 {
					doc = gen.Doc
				}
				p.types[spec.Name.Name] = &typeDecl{name: spec.Name.Name, spec: spec, doc: doc, imports: imports}
			}
		}
	}
	return p, nil
}

// references lists the parsed structs decl's type mentions, looking through
// named non-struct types (type Lanes []Lane) along the way.
func (g *generator) references(pkgAlias string, decl *typeDecl, visited map[ref]bool) []ref {
	var found []ref
	follow := func(alias string, d *typeDecl) {
		r := ref{alias, d.name}
		if _, isStruct := d.spec.Type.(*ast.StructType); isStruct {
			found = append(found, r)
			return
		}
		if !visited[r] {
			visited[r] = true
			found = append(found, g.references(alias, d, visited)...)
		}
	}
	var walk func(expr ast.Expr)
	walk = func(expr ast.Expr) {
		switch t := expr.(type) {
		case *ast.Ident:
			if d, ok := g.pkgs[pkgAlias].types[t.Name]; ok && d != decl {
				follow(pkgAlias, d)
			}
		case *ast.SelectorExpr:
			if x, ok := t.X.(*ast.Ident); ok {
				if alias := g.aliasFor(decl, x.Name); alias != "" && ast.IsExported(t.Sel.Name) {
					if d, ok := g.pkgs[alias].types[t.Sel.Name]; ok {
						follow(alias, d)
					}
				}
			}
		case *ast.StarExpr:
			walk(t.X)
		case *ast.ArrayType:
			walk(t.Elt)
		case *ast.MapType:
			walk(t.Value)
		case *ast.StructType:
			// Only field types: a field NAMED like a type is not a reference.
			for _, f := range t.Fields.List {
				if name, _, _ := jsonTag(f); name == "-" {
					continue
				}
				walk(f.Type)
			}
		}
	}
	walk(decl.spec.Type)
	return found
}

// aliasFor resolves a selector's package name, as written in decl's file, to
// one of the parsed packages, or "" when it is some other package.
func (g *generator) aliasFor(decl *typeDecl, local string) string {
	path, ok := decl.imports[local]
	if !ok {
		return ""
	}
	for _, src := range sources {
		if strings.HasSuffix(path, "/"+src.dir) {
			return src.alias
		}
	}
	return ""
}

// field is one property of an emitted interface after encoding/json's rules
// for tags and embedding have been applied.
type field struct {
	name     string
	tsType   string
	optional bool
	doc      string
	depth    int
	tagged   bool
	index    int // declaration order, for output
}

func (g *generator) writeInterface(b *bytes.Buffer, r ref) error {
	decl := g.pkgs[r.pkg].types[r.name]
	st := decl.spec.Type.(*ast.StructType)

	fields, err := g.collectFields(r.pkg, decl, st, 0, false, map[ref]bool{r: true})
	if err != nil {
		return fmt.Errorf("%s.%s: %w", r.pkg, r.name, err)
	}
	fields = dominantFields(fields)

	doc := commentText(decl.doc)
	source := "Go: " + r.pkg + "." + r.name
	if doc != "" {
		doc += "\n\n" + source
	} else {
		doc = source
	}
	writeDoc(b, "", doc)
	fmt.Fprintf(b, "export interface %s {\n", g.tsName[r])
	for _, f := range fields {
		if f.doc != "" {
			writeDoc(b, "  ", f.doc)
		}
		opt := ""
		if f.optional {
			opt = "?"
		}
		fmt.Fprintf(b, "  %s%s: %s;\n", propName(f.name), opt, f.tsType)
	}
	b.WriteString("}\n")
	return nil
}

// collectFields flattens a struct the way encoding/json sees it. Embedded
// structs without a json name contribute their fields one level deeper, which
// dominantFields later uses to resolve name clashes.
func (g *generator) collectFields(pkgAlias string, decl *typeDecl, st *ast.StructType, depth int, viaPointer bool, seen map[ref]bool) ([]field, error) {
	var out []field
	for _, f := range st.Fields.List {
		tagName, opts, hasTag := jsonTag(f)
		if tagName == "-" && len(opts) == 0 {
			continue // `json:"-"`; only `json:"-,"` names a field "-"
		}
		doc := commentText(f.Doc)
		if doc == "" {
			doc = commentText(f.Comment)
		}

		if len(f.Names) == 0 {
			// Embedded field.
			base, isPtr := f.Type, false
			if star, ok := base.(*ast.StarExpr); ok {
				base, isPtr = star.X, true
			}
			if tagName == "" {
				if er, emb, ok := g.resolveStruct(pkgAlias, decl, base); ok {
					if seen[er] {
						return nil, fmt.Errorf("recursive embedding of %s", er.name)
					}
					next := map[ref]bool{er: true}
					for k := range seen {
						next[k] = true
					}
					inner, err := g.collectFields(er.pkg, emb, emb.spec.Type.(*ast.StructType), depth+1, viaPointer || isPtr, next)
					if err != nil {
						return nil, err
					}
					out = append(out, inner...)
					continue
				}
			}
			goName := embeddedName(base)
			if goName == "" || (!ast.IsExported(goName) && tagName == "") {
				continue
			}
			name := goName
			if tagName != "" {
				name = tagName
			}
			out = append(out, g.makeField(pkgAlias, decl, name, f.Type, opts, doc, depth, hasTag && tagName != "", viaPointer))
			continue
		}

		for _, id := range f.Names {
			if !ast.IsExported(id.Name) {
				continue
			}
			name := id.Name
			if tagName != "" {
				name = tagName
			}
			out = append(out, g.makeField(pkgAlias, decl, name, f.Type, opts, doc, depth, hasTag && tagName != "", viaPointer))
		}
	}
	for i := range out {
		out[i].index = i
	}
	return out, nil
}

func (g *generator) makeField(pkgAlias string, decl *typeDecl, name string, expr ast.Expr, opts []string, doc string, depth int, tagged, viaPointer bool) field {
	ts, note := g.tsType(pkgAlias, decl, expr)
	if hasOpt(opts, "string") && (ts == "number" || ts == "boolean") {
		ts = "string" // `,string` quotes scalars on the wire
	}
	if note != "" {
		if doc != "" {
			doc += "\n\n"
		}
		doc += note
	}
	return field{
		name:     name,
		tsType:   ts,
		optional: hasOpt(opts, "omitempty") || hasOpt(opts, "omitzero") || viaPointer,
		doc:      doc,
		depth:    depth,
		tagged:   tagged,
	}
}

// dominantFields applies encoding/json's clash rule: for each name the
// shallowest field wins; at equal depth a single tagged field wins; otherwise
// the name is dropped altogether.
func dominantFields(all []field) []field {
	byName := map[string][]field{}
	var order []string
	for _, f := range all {
		if _, ok := byName[f.name]; !ok {
			order = append(order, f.name)
		}
		byName[f.name] = append(byName[f.name], f)
	}
	var out []field
	for _, name := range order {
		group := byName[name]
		min := group[0].depth
		for _, f := range group {
			if f.depth < min {
				min = f.depth
			}
		}
		var top []field
		for _, f := range group {
			if f.depth == min {
				top = append(top, f)
			}
		}
		if len(top) == 1 {
			out = append(out, top[0])
			continue
		}
		var tagged []field
		for _, f := range top {
			if f.tagged {
				tagged = append(tagged, f)
			}
		}
		if len(tagged) == 1 {
			out = append(out, tagged[0])
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].index < out[j].index })
	return out
}

// resolveStruct finds the struct declaration an expression names, in the
// declaring package or another parsed one.
func (g *generator) resolveStruct(pkgAlias string, decl *typeDecl, expr ast.Expr) (ref, *typeDecl, bool) {
	switch t := expr.(type) {
	case *ast.Ident:
		if d, ok := g.pkgs[pkgAlias].types[t.Name]; ok {
			if _, isStruct := d.spec.Type.(*ast.StructType); isStruct {
				return ref{pkgAlias, t.Name}, d, true
			}
		}
	case *ast.SelectorExpr:
		if x, ok := t.X.(*ast.Ident); ok {
			if alias := g.aliasFor(decl, x.Name); alias != "" {
				if d, ok := g.pkgs[alias].types[t.Sel.Name]; ok {
					if _, isStruct := d.spec.Type.(*ast.StructType); isStruct {
						return ref{alias, t.Sel.Name}, d, true
					}
				}
			}
		}
	}
	return ref{}, nil, false
}

// tsType maps a Go type expression to TypeScript. The note, when not empty,
// explains a lossy mapping and is attached to the field's doc comment.
func (g *generator) tsType(pkgAlias string, decl *typeDecl, expr ast.Expr) (string, string) {
	switch t := expr.(type) {
	case *ast.Ident:
		if ts, ok := builtin(t.Name); ok {
			return ts, ""
		}
		if r, _, ok := g.resolveStruct(pkgAlias, decl, t); ok {
			if name, ok := g.tsName[r]; ok {
				return name, ""
			}
			return r.name, ""
		}
		if d, ok := g.pkgs[pkgAlias].types[t.Name]; ok {
			// A named non-struct type (type Status string): its underlying type.
			return g.tsType(pkgAlias, d, d.spec.Type)
		}
		return "unknown", "Go type " + t.Name + " is not mapped."
	case *ast.StarExpr:
		inner, note := g.tsType(pkgAlias, decl, t.X)
		if inner == "unknown" {
			return inner, note
		}
		return inner + " | null", note
	case *ast.ArrayType:
		if id, ok := t.Elt.(*ast.Ident); ok && (id.Name == "byte" || id.Name == "uint8") && t.Len == nil {
			return "unknown", "Go []byte (a gorm jsonb blob): encoding/json sends it base64-encoded."
		}
		elem, note := g.tsType(pkgAlias, decl, t.Elt)
		if strings.Contains(elem, " ") {
			elem = "(" + elem + ")"
		}
		return elem + "[]", note
	case *ast.MapType:
		val, note := g.tsType(pkgAlias, decl, t.Value)
		return "Record<string, " + val + ">", note
	case *ast.InterfaceType:
		return "unknown", ""
	case *ast.StructType:
		fields, err := g.collectFields(pkgAlias, decl, t, 0, false, map[ref]bool{})
		if err != nil {
			return "unknown", err.Error()
		}
		fields = dominantFields(fields)
		parts := make([]string, 0, len(fields))
		for _, f := range fields {
			opt := ""
			if f.optional {
				opt = "?"
			}
			parts = append(parts, propName(f.name)+opt+": "+f.tsType)
		}
		if len(parts) == 0 {
			return "Record<string, never>", ""
		}
		return "{ " + strings.Join(parts, "; ") + " }", ""
	case *ast.SelectorExpr:
		x, _ := t.X.(*ast.Ident)
		if x == nil {
			return "unknown", ""
		}
		path := decl.imports[x.Name]
		switch path + "." + t.Sel.Name {
		case "time.Time":
			return "string", ""
		case "time.Duration":
			return "number", ""
		case "encoding/json.RawMessage", "github.com/gin-gonic/gin.H":
			return "unknown", ""
		case "encoding/json.Number":
			return "number", ""
		}
		if r, _, ok := g.resolveStruct(pkgAlias, decl, t); ok {
			if name, ok := g.tsName[r]; ok {
				return name, ""
			}
			return r.name, ""
		}
		if alias := g.aliasFor(decl, x.Name); alias != "" {
			if d, ok := g.pkgs[alias].types[t.Sel.Name]; ok {
				return g.tsType(alias, d, d.spec.Type)
			}
		}
		return "unknown", "External Go type " + x.Name + "." + t.Sel.Name + " is not mapped."
	}
	return "unknown", fmt.Sprintf("Go type %T is not mapped.", expr)
}

func builtin(name string) (string, bool) {
	switch name {
	case "string":
		return "string", true
	case "bool":
		return "boolean", true
	case "int", "int8", "int16", "int32", "int64",
		"uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
		"float32", "float64", "byte", "rune":
		return "number", true
	case "any":
		return "unknown", true
	case "error":
		return "unknown", true
	}
	return "", false
}

// jsonTag returns the tag's name, its options, and whether a json tag exists.
func jsonTag(f *ast.Field) (string, []string, bool) {
	if f.Tag == nil {
		return "", nil, false
	}
	raw, err := strconv.Unquote(f.Tag.Value)
	if err != nil {
		return "", nil, false
	}
	value, ok := reflect.StructTag(raw).Lookup("json")
	if !ok {
		return "", nil, false
	}
	parts := strings.Split(value, ",")
	return parts[0], parts[1:], true
}

func hasOpt(opts []string, want string) bool {
	for _, o := range opts {
		if o == want {
			return true
		}
	}
	return false
}

func embeddedName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		return t.Sel.Name
	}
	return ""
}

func commentText(cg *ast.CommentGroup) string {
	if cg == nil {
		return ""
	}
	lines := strings.Split(strings.TrimSpace(cg.Text()), "\n")
	// A /* */ block keeps its source indentation after the first line; drop
	// the part every continuation line shares.
	prefix := ""
	first := true
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lead := line[:len(line)-len(strings.TrimLeft(line, " \t"))]
		if first || !strings.HasPrefix(lead, prefix) {
			if first {
				prefix = lead
			} else {
				for !strings.HasPrefix(lead, prefix) {
					prefix = prefix[:len(prefix)-1]
				}
			}
			first = false
		}
	}
	for i := 1; i < len(lines); i++ {
		lines[i] = strings.TrimPrefix(lines[i], prefix)
	}
	return strings.Join(lines, "\n")
}

func writeDoc(b *bytes.Buffer, indent, text string) {
	text = strings.ReplaceAll(text, "*/", "*\\/")
	lines := strings.Split(text, "\n")
	b.WriteString(indent + "/**\n")
	for _, line := range lines {
		line = strings.TrimRight(line, " \t")
		if line == "" {
			b.WriteString(indent + " *\n")
			continue
		}
		b.WriteString(indent + " * " + line + "\n")
	}
	b.WriteString(indent + " */\n")
}

func propName(name string) string {
	for i, r := range name {
		ok := r == '_' || r == '$' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (i > 0 && r >= '0' && r <= '9')
		if !ok {
			return strconv.Quote(name)
		}
	}
	if name == "" {
		return `""`
	}
	return name
}
