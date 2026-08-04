$baseUrl = "https://autopilot-backend-pl6j.onrender.com"

# Step 1: Seed cookies
Write-Host "`n=== Step 1: Seeding browser cookies ===" -ForegroundColor Cyan

$cookie = @"
_t_ds=8ffdc53f1785783329-98ffdc53f-08ffdc53f; J=0; _ga=GA1.1.642938319.1785783332; test=naukri.com; _t_us=6A721225; _t_s=direct; _t_r=1030%2F%2F; persona=default; ak_bmsc=96DA96FC51DB619DFFCE29889B42824C~000000000000000000000000000000~YAAQ1AVaaL14eqafAQAAwuiWzQAGHmiAbb0kTaPzupMFjPitCjfbu523PxUKfXLeFvn7kDEBH4kjc3sIabP/EYgTALHbNhbA2uLOc1nyrwAlnyOvKelJBcVmc9Bi5qvCMRT/GvTW0S9vIdutWIqKKeN+a1Yk6tm2W9/BM3fYqG9ATY1SjO5PV7pncp0DnvCXGRVyS+7/bC22y5AaetXK4cZMwkyM2kZnEaaNJ1z4Kq8GXkY1eF2ZlDCBt7LyquCwvfiWz2vJdaosszPklB8gVLJP+A+D7vhfLmF8YA5FnE2oZavSPqaF7iySp3dDjLDEkxe4Q0ibaIahS983mMyD/bJFzX1rodVUbufhrItM1i8nmWDJz7X3G0C6uS9gjfxNagcIqwAM2y2tUpwjpgtfnt0dLtKaXxQTeSEi2tNhofwy7Tq+RY4IatlZ9J6c2EZxlU9MzoM6hMA27QkoxKLS2wCVgHOMMBQkMJJ16T2Zm2h47J3ZxA==; nauk_at=eyJraWQiOiIzIiwidHlwIjoiSldUIiwiYWxnIjoiUlM1MTIifQ.eyJkZXZpY2VUeXBlIjoiZDNza3QwcCIsInVkX3Jlc0lkIjoyNjM0NTQxNjYsInN1YiI6IjI3NDQ1ODg2MiIsInVkX3VzZXJuYW1lIjoiYmh1amVqYWFua2l0QGdtYWlsLmNvbSIsInVkX2lzRW1haWwiOnRydWUsImlzcyI6IkluZm9FZGdlIEluZGlhIFB2dC4gTHRkLiIsInVzZXJBZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQpIEFwcGxlV2ViS2l0LzUzNy4zNiAoS0hUTUwsIGxpa2UgR2Vja28pIENocm9tZS8xNTAuMC4wLjAgU2FmYXJpLzUzNy4zNiIsImlwQWRyZXNzIjoiMjQwOTo0MDkwOjgwNDQ6ZmMwMzo4MDpkYTYxOmZkNDg6NDc3OSIsInVkX2lzVGVjaE9wc0xvZ2luIjpmYWxzZSwidXNlcklkIjoyNzQ0NTg4NjIsInN1YlVzZXJUeXBlIjoiam9ic2Vla2VyIiwidXNlclN0YXRlIjoiQVVUSEVOVElDQVRFRCIsInVkX2lzUGFpZENsaWVudCI6ZmFsc2UsInVkX2VtYWlsVmVyaWZpZWQiOnRydWUsInVzZXJUeXBlIjoiam9ic2Vla2VyIiwic2Vzc2lvblN0YXRUaW1lIjoiMjAyNi0wOC0wNFQyMTo1NDoxMCIsInVkX2VtYWlsIjoiYmh1amVqYWFua2l0QGdtYWlsLmNvbSIsInVzZXJSb2xlIjoidXNlciIsImV4cCI6MTc4NTg2NDI1MCwidG9rZW5UeXBlIjoiYWNjZXNzVG9rZW4iLCJpYXQiOjE3ODU4NjA2NTAsImp0aSI6IjZjZWMyMWZkOWUyNTQ3ZGRiOTBjODJlOTgyMTY0NGNmIiwicG9kSWQiOiJwcm9kLTViYmM2YmI1OWItNWZkY3cifQ.YwD-5jC2gbeBayPQHtZWURx8c3O43bBV-K3yNX6j-_BOhxEjNywGQjR-Oz2oIrjSReV77u_Gzg9sp9OPFpG_CMCyXO2DjUw4RHslk44NWQV99uBhAEnzvw2zvlHwgc_wI4rIvsx7XIaA7QBf_eDTf8gcmf2syy-PCdcg3psw4i_V91WBamhHdqnQLyO76DCJrECeOCDjlxQjzz1KB8I6USSHbkw-N4d8MVs6ERk1BzBfzDdcmyP0J9XWTZBw0KTz9BjRZYOFQHlVx3xe9iuxHlUngOH0Y_3SPEWf9DSKNhM30pVg-kMzALcio3G7sYdZLXgW2nGlwXlC_LVZLYG7-Q; nauk_rt=6cec21fd9e2547ddb90c82e9821644cf; is_login=1; nauk_sid=6cec21fd9e2547ddb90c82e9821644cf; nauk_otl=6cec21fd9e2547ddb90c82e9821644cf; NKWAP=054ebe0127bf24990d27a01b91bb4ff556e9b8c9ba447c9d13496a327caf376c237376ccad94d1f7~054ebe0127bf24990d27a01b91bb4ff556e9b8c9ba447c9d13496a327caf376c237376ccad94d1f7~1~0; MYNAUKRI[UNID]=0112f82f06564a5b817adec5b684aed0; nauk_ps=default; nauk_cs=default; _gcl_au=1.1.1538644165.1785783331.1469953076.1785860649.1785860650.236663969.1785783332.1785860662; bm_sv=95D77DC38BAD786137525128A9740B12~YAAQ1AVaaJiDeqafAQAA1kOXzQDzeYWBqJ+6WhNP3ejZoNiSsr7O3Y2zmHS2VW99mgVV9IwMnUvFTAyombqPXOZOABSGL3vAQAuyeLTX4uaDRMmF9X3pYh41gNKw5B4e3rF6RZShupryhdjLmYNhTA0sy7UtK/pHulMVtBZgyFoXud1k+bBBbPLvwTKgTQ7/L1Ag3mLidafDx3TEo/aOjYkVmZdDTzPlMG9rIiZTnfZSq3YUkAAt7u0BtfuM7Yqh2g==~1; HOWTORT=cl=1785860648448&r=https%3A%2F%2Fwww.naukri.com%2Fmnjuser%2Fhomepage&nu=https%3A%2F%2Flogin.naukri.com%2FnLogin%2FLogin.php&ul=1785860670224&hd=1785860670479
"@

$body1 = @{ cookie = $cookie } | ConvertTo-Json
$result1 = Invoke-RestMethod -Uri "$baseUrl/api/auth/session" -Method POST -ContentType "application/json" -Body $body1
Write-Host ($result1 | ConvertTo-Json -Depth 5) -ForegroundColor Green

Start-Sleep -Seconds 2

# Step 2: Test refresh
Write-Host "`n=== Step 2: Testing silent token refresh ===" -ForegroundColor Cyan
try {
    $result2 = Invoke-RestMethod -Uri "$baseUrl/api/auth/refresh" -Method POST -ContentType "application/json"
    Write-Host ($result2 | ConvertTo-Json -Depth 5) -ForegroundColor Green
} catch {
    Write-Host "Refresh failed (may need OTP): $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "Continuing with seeded token..." -ForegroundColor Yellow
}

Start-Sleep -Seconds 2

# Step 3: Check status
Write-Host "`n=== Step 3: Checking auth status ===" -ForegroundColor Cyan
$result3 = Invoke-RestMethod -Uri "$baseUrl/api/auth/status" -Method GET
Write-Host ($result3 | ConvertTo-Json -Depth 5) -ForegroundColor Green

Start-Sleep -Seconds 2

# Step 4: Update profile
Write-Host "`n=== Step 4: Updating Naukri profile ===" -ForegroundColor Cyan
$body4 = @{ provider = "naukri"; trigger = "MANUAL"; dryRun = $false } | ConvertTo-Json
$result4 = Invoke-RestMethod -Uri "$baseUrl/api/profile/update" -Method POST -ContentType "application/json" -Body $body4
Write-Host ($result4 | ConvertTo-Json -Depth 5) -ForegroundColor Green

Write-Host "`n=== ALL DONE ===" -ForegroundColor Cyan
