#!/usr/bin/env bash
# Build <name>-<version>.vsix without node/vsce: a .vsix is a zip with
# a manifest. Install with:  code --install-extension kernel-workbench-*.vsix
#                       or:  codium --install-extension kernel-workbench-*.vsix
set -euo pipefail
cd "$(dirname "$0")/.."

read -r name version < <(python3 -c '
import json; p = json.load(open("package.json"))
print(p["name"], p["version"])')
out=$PWD/$name-$version.vsix
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/extension"
cp -r package.json extension.js src scripts media README.md CHANGELOG.md LICENSE "$stage/extension/"
rm -f "$stage/extension/scripts/package-vsix.sh" "$stage/extension/scripts/test.sh"

python3 - "$stage" <<'EOF'
import json, sys, html
stage = sys.argv[1]
p = json.load(open("package.json"))
e = html.escape
open(f"{stage}/extension.vsixmanifest", "w").write(f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{e(p["name"])}" Version="{e(p["version"])}" Publisher="{e(p["publisher"])}"/>
    <DisplayName>{e(p["displayName"])}</DisplayName>
    <Description xml:space="preserve">{e(p["description"])}</Description>
    <Tags>{e(",".join(p.get("keywords", [])))}</Tags>
    <Categories>{e(",".join(p.get("categories", [])))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{e(p["engines"]["vscode"])}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
  </Assets>
</PackageManifest>
''')
open(f"{stage}/[Content_Types].xml", "w").write('''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".sh" ContentType="application/x-sh"/>
  <Default Extension=".py" ContentType="text/x-python"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
''')
EOF

rm -f "$out"
(cd "$stage" && zip -qr -X "$out" '[Content_Types].xml' extension.vsixmanifest extension)
echo "$out"
