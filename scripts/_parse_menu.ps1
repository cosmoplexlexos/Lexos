$src = "C:\Users\rayaa\Desktop\WiseOrder_Menu.xlsx"
$tmp = "$env:TEMP\wo_menu_copy.xlsx"
Copy-Item $src $tmp -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($tmp)
function ReadEntry($name) {
  $e = $zip.Entries | Where-Object { $_.FullName -eq $name }
  if (-not $e) { return $null }
  $r = New-Object System.IO.StreamReader($e.Open()); $t = $r.ReadToEnd(); $r.Close(); return $t
}
function Dec($s) { $s -replace '&amp;','&' -replace '&lt;','<' -replace '&gt;','>' -replace '&quot;','"' -replace '&#39;',"'" -replace '&apos;',"'" }

$ss = ReadEntry "xl/sharedStrings.xml"
$shared = New-Object System.Collections.ArrayList
foreach ($m in ([regex]'(?s)<si>(.*?)</si>').Matches($ss)) {
  $parts = foreach ($t in ([regex]'(?s)<t[^>]*>(.*?)</t>').Matches($m.Groups[1].Value)) { $t.Groups[1].Value }
  [void]$shared.Add((Dec ($parts -join '')))
}

$sheet = ReadEntry "xl/worksheets/sheet1.xml"
$items = New-Object System.Collections.ArrayList
$category = ""
foreach ($rm in ([regex]'(?s)<row[^>]*>(.*?)</row>').Matches($sheet)) {
  $cols = @{}
  foreach ($cm in ([regex]'(?s)<c r="([A-Z]+)\d+"([^>]*)>(.*?)</c>').Matches($rm.Groups[1].Value)) {
    $col = $cm.Groups[1].Value; $attrs = $cm.Groups[2].Value; $body = $cm.Groups[3].Value
    $val = ''
    $vm = ([regex]'(?s)<v>(.*?)</v>').Match($body)
    if ($vm.Success) { $val = $vm.Groups[1].Value }
    if ($attrs -match 't="s"' -and $val -ne '') { $val = $shared[[int]$val] }
    if ($val -ne '') { $cols[$col] = $val }
  }
  $a = $cols['A']; $b = $cols['B']
  if ($a -and -not $b) {
    $category = ($a -replace '\s*\(.*\)\s*$','').Trim()
  } elseif ($a -match '^\d+$' -and $b) {
    $aliases = @()
    if ($cols['H']) { $aliases = ($cols['H'] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    $names = @($cols['C'],$cols['D'],$cols['E'],$cols['F'],$cols['G']) | Where-Object { $_ }
    $price = $null; if ($cols['I'] -match '^\d+(\.\d+)?$') { $price = [double]$cols['I'] }
    [void]$items.Add([ordered]@{ name=$b; category=$category; price=$price; names=$names; aliases=$aliases })
  }
}
$zip.Dispose(); Remove-Item $tmp -Force

$out = [ordered]@{ tenant_id='wiseorder'; display_name='WiseOrder'; items=$items }
$json = $out | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText("C:\Users\rayaa\Desktop\lexos\scripts\data\wiseorder-menu.json", $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host ("Wrote scripts/data/wiseorder-menu.json - " + $items.Count + " items")
