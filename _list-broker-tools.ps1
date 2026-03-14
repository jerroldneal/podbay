$body = @{ jsonrpc = "2.0"; method = "tools/list"; params = @{}; id = 1 } | ConvertTo-Json
$resp = Invoke-RestMethod -Uri 'http://localhost:3098/mcp' -Method Post -Body $body -ContentType 'application/json' -Headers @{Accept='application/json, text/event-stream'}
$resp.result.tools | Select-Object -ExpandProperty name | Sort-Object
