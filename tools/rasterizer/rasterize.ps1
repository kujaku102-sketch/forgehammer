param (
    [string]$ImagePath = "C:/Users/Masaya.Futamata/.gemini/antigravity/brain/27f3b6d1-4c51-43ed-a78f-e53450eb7bc6/.user_uploaded/media_1792722526853_fe651d96.png",
    [int]$Columns = 96,
    [string]$OutputPath = "C:/Users/Masaya.Futamata/Documents/forgehammer/tools/rasterizer/output_logo.ans"
)

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile($ImagePath)
# Each character displays 2 vertical pixels using upper half block (▀)
# Terminal fonts have aspect ratio roughly 1:2 (width:height), so 1 char is square when 2 vertical pixels are used.
$targetWidth = $Columns
$aspect = [double]$src.Height / [double]$src.Width
# Total vertical pixels = targetWidth * aspect
$targetHeight = [int][Math]::Round($targetWidth * $aspect)
# Ensure even height for 2-pixel pairs
if ($targetHeight % 2 -ne 0) { $targetHeight++ }

# Create resized bitmap with high quality
$bmp = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $targetWidth, $targetHeight)
$g.Dispose()
$src.Dispose()

$sb = New-Object System.Text.StringBuilder
$lastFg = ""
$lastBg = ""

$ESC = [char]27

for ($y = 0; $y -lt $targetHeight; $y += 2) {
    for ($x = 0; $x -lt $targetWidth; $x++) {
        $top = $bmp.GetPixel($x, $y)
        $bot = $bmp.GetPixel($x, $y + 1)

        # Upper pixel is Foreground (character color of ▀), Lower pixel is Background
        $fgCode = "$($top.R);$($top.G);$($top.B)"
        $bgCode = "$($bot.R);$($bot.G);$($bot.B)"

        # ANSI optimizations: only emit color escape if changed
        if ($fgCode -ne $lastFg -or $bgCode -ne $lastBg) {
            $sb.Append("${ESC}[38;2;$($fgCode)m${ESC}[48;2;$($bgCode)m") | Out-Null
            $lastFg = $fgCode
            $lastBg = $bgCode
        }

        # Half block character
        $sb.Append([char]0x2580) | Out-Null
    }
    # Reset line end
    $sb.Append("${ESC}[0m`r`n") | Out-Null
    $lastFg = ""
    $lastBg = ""
}

$bmp.Dispose()
$sb.Append("${ESC}[0m") | Out-Null

$ansiString = $sb.ToString()
[System.IO.File]::WriteAllText($OutputPath, $ansiString, [System.Text.Encoding]::UTF8)

Write-Host "`n[FORGEHAMMER] Half-Block Rasterization Complete!" -ForegroundColor Cyan
Write-Host "Resolution: $($targetWidth)x$($targetHeight) px -> $($targetWidth) columns x $($targetHeight / 2) rows" -ForegroundColor Yellow
Write-Host "Saved to: $OutputPath`n" -ForegroundColor Green

# Print direct to terminal preview!
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Host $ansiString
