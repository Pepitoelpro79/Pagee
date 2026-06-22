param([int]$Port=5000)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DownloadsDir = Join-Path $ScriptDir "downloads"
$HtmlFile = Join-Path $ScriptDir "index.html"
$ytdlp = Join-Path $ScriptDir "yt-dlp.exe"
if (!(Test-Path $DownloadsDir)) { New-Item -ItemType Directory -Path $DownloadsDir -Force | Out-Null }

# Descargar yt-dlp.exe si no existe
if (!(Test-Path $ytdlp)) {
    Write-Host "[+] Descargando yt-dlp.exe..."
    $curl = Get-Command "curl.exe" -ErrorAction SilentlyContinue
    if ($curl) {
        & curl.exe -L -o $ytdlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    } else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        (New-Object System.Net.WebClient).DownloadFile("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe", $ytdlp)
    }
    if (!(Test-Path $ytdlp)) { Write-Host "[-] Error al descargar yt-dlp.exe"; exit 1 }
    Write-Host "[+] yt-dlp.exe listo"
}

# ffmpeg
$ffmpeg = Join-Path $ScriptDir "ffmpeg.exe"
$global:ffmpegPath = if (Get-Command "ffmpeg" -ErrorAction SilentlyContinue) { "ffmpeg" } elseif (Test-Path $ffmpeg) { $ffmpeg } else { $null }

if (!$global:ffmpegPath) {
    Write-Host "[+] Descargando ffmpeg.exe (para MP3)..."
    $zipUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    $zipPath = Join-Path $ScriptDir "ffmpeg.zip"
    try {
        $curl = Get-Command "curl.exe" -ErrorAction SilentlyContinue
        if ($curl) {
            & curl.exe -L -o $zipPath $zipUrl
        } else {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            (New-Object System.Net.WebClient).DownloadFile($zipUrl, $zipPath)
        }
        Expand-Archive -Path $zipPath -DestinationPath (Join-Path $ScriptDir "ffmpeg-temp") -Force -ErrorAction Stop
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        $found = Get-ChildItem -Path (Join-Path $ScriptDir "ffmpeg-temp") -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
        if ($found) {
            Copy-Item $found.FullName $ffmpeg -Force
            Remove-Item (Join-Path $ScriptDir "ffmpeg-temp") -Recurse -Force -ErrorAction SilentlyContinue
            $global:ffmpegPath = $ffmpeg
            Write-Host "[+] ffmpeg.exe listo"
        }
    } catch {
        Write-Host "[-] ffmpeg no descargado (MP3 no funcionara sin ffmpeg)"
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $ScriptDir "ffmpeg-temp") -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "============================================="
Write-Host "  YouTube Downloader - Servidor Activo"
Write-Host "============================================="
Write-Host "[+] Abre http://localhost:$Port/ en tu navegador"
Write-Host "[+] Presiona Ctrl+C para detener"
Write-Host "============================================="
Write-Host ""

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

:mainLoop while ($listener.IsListening) {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response
    $res.Headers.Add("Access-Control-Allow-Origin", "*")
    $res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    $res.Headers.Add("Access-Control-Allow-Headers", "Content-Type")

    if ($req.HttpMethod -eq "OPTIONS") { $res.StatusCode=204; $res.Close(); continue }

    $path = $req.RawUrl -split '\?' | Select-Object -First 1

    $body = $null
    if ($req.HttpMethod -eq "POST") {
        $reader = New-Object System.IO.StreamReader($req.InputStream)
        $raw = $reader.ReadToEnd()
        $reader.Close()
        try { $body = $raw | ConvertFrom-Json } catch { $body = @{} }
    }

    try {
        $bytes = $null
        $contentType = ""

        switch -Wildcard ($path) {
            "/" {
                $html = [System.IO.File]::ReadAllText($HtmlFile)
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($html)
                $contentType = "text/html; charset=utf-8"
            }
            "/info" {
                $url = $body.url
                if (!$url) { throw "URL requerida" }
                Write-Host "[i] Consultando info: $url"
                $proc = Start-Process -FilePath $ytdlp -ArgumentList "--dump-json","$url" -NoNewWindow -Wait -PassThru -RedirectStandardError "NUL" -RedirectStandardOutput "$env:TEMP\ytdlp_out.txt"
                $json = Get-Content "$env:TEMP\ytdlp_out.txt" -Raw
                if (!$json) { throw "No se pudo obtener informacion del video" }
                $info = $json | ConvertFrom-Json
                if (!$info) { throw "Error al analizar respuesta" }
                $result = @{ title=$info.title; duration=$info.duration; thumbnail=$info.thumbnail } | ConvertTo-Json -Compress
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($result)
                $contentType = "application/json"
                Write-Host "[OK] Info: $($info.title)"
            }
            "/download" {
                $url = $body.url
                $fmt = $body.format
                if (!$url) { throw "URL requerida" }

                $proc = Start-Process -FilePath $ytdlp -ArgumentList "--dump-json","$url" -NoNewWindow -Wait -PassThru -RedirectStandardError "NUL" -RedirectStandardOutput "$env:TEMP\ytdlp_out.txt"
                $json = Get-Content "$env:TEMP\ytdlp_out.txt" -Raw
                if (!$json) { throw "No se pudo obtener informacion del video" }
                $info = $json | ConvertFrom-Json
                $title = $info.title -replace '[\\/:*?"<>|]', ''

                $ext = if ($fmt -eq "mp3") { "mp3" } else { "mp4" }
                $outTmpl = "$DownloadsDir\$title.%(ext)s"

                if ($fmt -eq "mp3") {
                    $ffLoc = if ($global:ffmpegPath) { (Split-Path $global:ffmpegPath -Parent) } else { "" }
                    if ($ffLoc) {
                        $argStr = "-o `"$outTmpl`" -x --audio-format mp3 --audio-quality 0 --ffmpeg-location `"$ffLoc`" `"$url`""
                    } else {
                        $argStr = "-o `"$outTmpl`" -x --audio-format mp3 --audio-quality 0 `"$url`""
                    }
                } else {
                    $argStr = "-o `"$outTmpl`" -f bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best --merge-output-format mp4 `"$url`""
                }

                Write-Host "[+] Descargando: $title ($fmt)"
                $dlProc = Start-Process -FilePath $ytdlp -ArgumentList $argStr -NoNewWindow -Wait -PassThru -RedirectStandardError "$env:TEMP\ytdlp_err.txt" -RedirectStandardOutput "$env:TEMP\ytdlp_dl.txt"

                $errOut = Get-Content "$env:TEMP\ytdlp_err.txt" -Raw -ErrorAction SilentlyContinue
                if ($errOut) { Write-Host $errOut }

                $finalFile = "$DownloadsDir\$title.$ext"
                if (!(Test-Path $finalFile)) {
                    $found = Get-ChildItem $DownloadsDir | Where-Object { $_.Name -like "$title*" } | Select-Object -First 1
                    if ($found) { $finalFile = $found.FullName }
                    else { throw "No se encontro el archivo descargado" }
                }

                $result = @{ filename = (Split-Path $finalFile -Leaf) } | ConvertTo-Json -Compress
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($result)
                $contentType = "application/json"
                Write-Host "[OK] Descarga completa: $(Split-Path $finalFile -Leaf)"
            }
            "/file/*" {
                $fname = $path -replace '^/file/', ''
                $fname = [System.Net.WebUtility]::UrlDecode($fname)
                $fpath = Join-Path $DownloadsDir $fname
                if (!(Test-Path $fpath)) { throw "Archivo no encontrado" }
                $bytes = [System.IO.File]::ReadAllBytes($fpath)
                $ext = [System.IO.Path]::GetExtension($fname).ToLower()
                $contentType = @{
                    ".mp4"="video/mp4"; ".mp3"="audio/mpeg"; ".webm"="video/webm"
                    ".mkv"="video/x-matroska"; ".m4a"="audio/mp4"
                }[$ext]
                if (!$contentType) { $contentType = "application/octet-stream" }
                $res.Headers.Add("Content-Disposition", "attachment; filename=`"$fname`"")
            }
            default {
                $res.StatusCode = 404
                $err = @{ error = "Ruta no encontrada" } | ConvertTo-Json -Compress
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($err)
                $contentType = "application/json"
            }
        }

        if ($bytes -and $contentType) {
            $res.ContentType = $contentType
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        }
    } catch {
        $res.StatusCode = 500
        $errMsg = $_.Exception.Message
        Write-Host "[-] Error: $errMsg"
        $err = @{ error = $errMsg } | ConvertTo-Json -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($err)
        $res.ContentType = "application/json"
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    $res.Close()
}
$listener.Stop()
