#!/usr/bin/env pwsh

# PowerShell wrapper for GenAIAdvancedPRReviewer task
# This ensures Windows compatibility with Azure DevOps

param(
    [string]$azure_openai_endpoint,
    [string]$azure_openai_api_key,
    [string]$azure_openai_deployment_name,
    [string]$max_llm_calls = "100",
    [string]$review_threshold = "0.7",
    [string]$enable_code_suggestions = "true",
    [string]$enable_security_scanning = "true",
    [string]$support_self_signed_certificate = "false"
)

try {
    Write-Host "Starting GenAIAdvancedPRReviewer task on Windows..."
    
    # Check if Node.js is available
    $nodeVersion = node --version 2>$null
    if (-not $nodeVersion) {
        Write-Error "Node.js is not installed or not in PATH. Please install Node.js 16+ to use this task."
        exit 1
    }

    Write-Host "Node.js version: $nodeVersion"
    
    # Get the directory where this script is located
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    
    # Check if the JavaScript file exists
    $jsFile = Join-Path $scriptDir "index.js"
    if (-not (Test-Path $jsFile)) {
        Write-Error "index.js not found in $scriptDir. Please ensure the task is properly built."
        exit 1
    }

    Write-Host "Executing: $jsFile"
    
    # Set environment variables for the Node.js task
    $env:azure_openai_endpoint = $azure_openai_endpoint
    $env:azure_openai_api_key = $azure_openai_api_key
    $env:azure_openai_deployment_name = $azure_openai_deployment_name
    $env:max_llm_calls = $max_llm_calls
    $env:review_threshold = $review_threshold
    $env:enable_code_suggestions = $enable_code_suggestions
    $env:enable_security_scanning = $enable_security_scanning
    $env:support_self_signed_certificate = $support_self_signed_certificate
    
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
