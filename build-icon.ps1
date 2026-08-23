Add-Type -AssemblyName System.Drawing

# FlowPaper icon: minimal geometric line style (blue #3B82F6)

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $blue = [System.Drawing.Color]::FromArgb(255, 59, 130, 246)
    $k = [double]$size / 256.0

    $frameW = [single](12.0 * $k)
    $frame = [System.Drawing.Pen]::new($blue, $frameW)
    $frame.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $frame.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $frame.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $x = [single](36.0 * $k); $y = [single](36.0 * $k)
    $w = [single](184.0 * $k); $h = [single](184.0 * $k)
    $r = [single](32.0 * $k)
    $d = [single](2.0 * $r)

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc([single]($x+$w-$d), $y, $d, $d, 270, 90)
    $path.AddArc([single]($x+$w-$d), [single]($y+$h-$d), $d, $d, 0, 90)
    $path.AddArc($x, [single]($y+$h-$d), $d, $d, 90, 90)
    $path.CloseFigure()
    $g.DrawPath($frame, $path)

    $waveW = [single](10.0 * $k)
    $wave = [System.Drawing.Pen]::new($blue, $waveW)
    $wave.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $wave.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $wave.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $centers = @(100, 128, 156)
    $startX = [single](66.0 * $k)
    $endX = [single](190.0 * $k)
    $span = [double]($endX - $startX)
    $step = [double](2.0 * $k)
    $count = [int]([Math]::Floor($span / $step)) + 1

    foreach ($cy in $centers) {
        $pts = New-Object 'System.Drawing.PointF[]' $count
        $idx = 0
        for ($px = $startX; $px -le $endX; $px = [single]($px + $step)) {
            $t = [double]($px - $startX) / $span
            $waveY = [single]($cy * $k + [Math]::Sin($t * 4.0 * [Math]::PI) * 11.0 * $k)
            $pts[$idx] = [System.Drawing.PointF]::new([single]$px, $waveY)
            $idx++
        }
        $g.DrawLines($wave, $pts)
    }

    $frame.Dispose(); $wave.Dispose(); $path.Dispose(); $g.Dispose()
    return $bmp
}

$outPng = Join-Path $PSScriptRoot 'assets\icon.png'
$outIco = Join-Path $PSScriptRoot 'build\icon.ico'

if (-not (Test-Path (Join-Path $PSScriptRoot 'build'))) {
    New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'build') | Out-Null
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngBytes = @{}
foreach ($sz in $sizes) {
    $bmp = New-IconBitmap $sz
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes[$sz] = $ms.ToArray()
    $ms.Dispose(); $bmp.Dispose()
}

[System.IO.File]::WriteAllBytes($outPng, $pngBytes[256])

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($sz in $sizes) {
    $data = $pngBytes[$sz]
    $bw.Write([byte]$(if ($sz -ge 256) { 0 } else { $sz }))
    $bw.Write([byte]$(if ($sz -ge 256) { 0 } else { $sz }))
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$data.Length)
    $bw.Write([uint32]$offset)
    $offset += $data.Length
}
foreach ($sz in $sizes) {
    $bw.Write($pngBytes[$sz])
}
$bw.Flush()
[System.IO.File]::WriteAllBytes($outIco, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

Write-Output "OK png size: $($pngBytes[256].Length) bytes"
Write-Output "OK ico size: $((Get-Item $outIco).Length) bytes"
