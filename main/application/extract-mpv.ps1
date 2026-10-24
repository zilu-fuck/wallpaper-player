$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($env:WALLPAPER_MPV_ARCHIVE)
try {
    $root = [IO.Path]::GetFullPath($env:WALLPAPER_MPV_EXTRACT).TrimEnd('\') + '\'
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $entries = @()
    [long]$total = 0
    if ($archive.Entries.Count -gt 8192) { throw 'Archive entry limit exceeded' }
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        $isDirectory = $name.EndsWith('/')
        $segments = $name.TrimEnd('/').Split('/')
        if ([string]::IsNullOrWhiteSpace($name) -or [IO.Path]::IsPathRooted($name) -or $segments.Count -gt 16) { throw 'Invalid archive path' }
        foreach ($segment in $segments) {
            if (!$segment -or $segment -eq '.' -or $segment -eq '..' -or $segment.EndsWith('.') -or $segment.EndsWith(' ') -or
                $segment.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $segment -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { throw 'Invalid archive entry name' }
        }
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $name.Replace('/', '\')))
        if (!$target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or !$seen.Add($target.TrimEnd('\'))) { throw 'Conflicting archive path' }
        $mode = ($entry.ExternalAttributes -shr 16) -band 61440
        if ($mode -eq 40960 -or ($entry.ExternalAttributes -band 1024)) { throw 'Archive links are unsupported' }
        if ($entry.Length -gt 268435456) { throw 'Archive file size limit exceeded' }
        $total += $entry.Length
        if ($total -gt 1073741824) { throw 'Archive expanded size limit exceeded' }
        $entries += @{ Entry = $entry; Target = $target; Directory = $isDirectory }
    }
    $buffer = New-Object byte[] 65536
    foreach ($item in $entries) {
        if ($item.Directory) { [IO.Directory]::CreateDirectory($item.Target) | Out-Null; continue }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Target)) | Out-Null
        $inputStream = $item.Entry.Open()
        try {
            $outputStream = [IO.File]::Open($item.Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            try {
                [long]$written = 0
                while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $written += $read
                    if ($written -gt $item.Entry.Length) { throw 'Archive file length mismatch' }
                    $outputStream.Write($buffer, 0, $read)
                }
                if ($written -ne $item.Entry.Length) { throw 'Incomplete archive entry' }
            } finally { $outputStream.Dispose() }
        } finally { $inputStream.Dispose() }
    }
} finally { $archive.Dispose() }
