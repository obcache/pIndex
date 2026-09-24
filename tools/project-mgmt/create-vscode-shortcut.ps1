function New-CodeShortcut {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [string] $Name = (Split-Path $Path -Leaf)
    )

    $Path = (Resolve-Path $Path).Path

    # Find VS Code
    $CodeExe = @(
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
        "$env:ProgramFiles\Microsoft VS Code\Code.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $CodeExe) {
        throw "Couldn't find Code.exe"
    }

    # Output locations
    $Desktop = [Environment]::GetFolderPath("Desktop")
    $IconDir = Join-Path $env:LOCALAPPDATA "CodeShortcutIcons"
    New-Item $IconDir -ItemType Directory -Force | Out-Null

    $safeName = $Name -replace '[\\/:*?"<>|]', '_'
    $IconPath = Join-Path $IconDir "$safeName.ico"
    $ShortcutPath = Join-Path $Desktop "$Name.lnk"

    # Extract normal VS Code icon
    Add-Type -AssemblyName System.Drawing
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($CodeExe)
    $tempPng = Join-Path $env:TEMP "$([guid]::NewGuid()).png"
    $icon.ToBitmap().Save(
        $tempPng,
        [System.Drawing.Imaging.ImageFormat]::Png
    )

    # Random hue. ImageMagick: 100 = unchanged hue.
    $hue = Get-Random -Minimum 0 -Maximum 200

    magick $tempPng `
        -modulate "100,115,$hue" `
        -define icon:auto-resize=256,128,64,48,32,16 `
        $IconPath

    Remove-Item $tempPng

    # Create .lnk
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($ShortcutPath)

    $lnk.TargetPath = $CodeExe
    $lnk.Arguments = "--new-window `"$Path`""
    $lnk.WorkingDirectory = $Path
    $lnk.IconLocation = "$IconPath,0"
    $lnk.Description = "Open $Name in a new VS Code window"
    $lnk.Save()

    Write-Host "Created: $ShortcutPath"
}

function Invoke-CodeShortcutPrompt {
    while ($true) {
        # Ask for the project path
        $Path = Read-Host "Enter the path to the project"

        # Remove accidental surrounding quotes
        $Path = $Path.Trim().Trim('"')

        # Validate that it exists and is a directory
        if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
            Write-Host ""
            Write-Host "That directory does not exist:" -ForegroundColor Red
            Write-Host "  $Path"
            Write-Host ""

            $retry = Read-Host "[T]ry again or [C]ancel?"

            if ($retry -match '^[Cc]') {
                Write-Host "Cancelled."
                return
            }

            continue
        }

        # Resolve it so the user sees the actual absolute path
        $Path = (Resolve-Path -LiteralPath $Path).Path

        Write-Host ""
        Write-Host "VS Code shortcut path:" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  $Path" -ForegroundColor White
        Write-Host ""

        $choices = @(
            [System.Management.Automation.Host.ChoiceDescription]::new(
                "&Confirm",
                "Create the shortcut using this path."
            ),
            [System.Management.Automation.Host.ChoiceDescription]::new(
                "C&hange",
                "Enter a different path."
            ),
            [System.Management.Automation.Host.ChoiceDescription]::new(
                "&Cancel",
                "Cancel without creating a shortcut."
            )
        )

        $choice = $Host.UI.PromptForChoice(
            "Confirm Path",
            "What would you like to do?",
            $choices,
            0
        )

        switch ($choice) {
            0 {
                # Confirm
                New-CodeShortcut -Path $Path
                return
            }

            1 {
                # Change — loop back to path entry
                Write-Host ""
                continue
            }

            2 {
                # Cancel
                Write-Host ""
                Write-Host "Cancelled."
                return
            }
        }
    }
}

Invoke-CodeShortcutPrompt