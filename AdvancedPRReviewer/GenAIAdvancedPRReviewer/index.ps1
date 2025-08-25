#!/usr/bin/env pwsh

# PowerShell wrapper for GenAIAdvancedPRReviewer task
# This ensures Windows compatibility

try {
    # Check if Node.js is available
    $nodeVersion = node --version 2>$null
    if (-not $nodeVersion) {
        Write-Error "Node.js is not installed or not in PATH. Please install Node.js 18+ to use this task."
        exit 1
    }

    # Get the directory where this script is located
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    
    # Check if the JavaScript file exists
    $jsFile = Join-Path $scriptDir "index.js"
    if (-not (Test-Path $jsFile)) {
        Write-Error "index.js not found in $scriptDir. Please ensure the task is properly built."
        exit 1
    }

    # Execute the Node.js task
    Write-Host "Starting GenAIAdvancedPRReviewer task..."
    Write-Host "Node.js version: $nodeVersion"
    Write-Host "Executing: $jsFile"
    
    # Run the Node.js task
    & node $jsFile
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Task execution failed with exit code: $LASTEXITCODE"
        exit $LASTEXITCODE
    }
    
    Write-Host "Task completed successfully."
    
} catch {
    Write-Error "PowerShell execution error: $_"
    exit 1
}
