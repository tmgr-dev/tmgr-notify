# Security

## Token handling

The notify token (`TMGR_NOTIFY_TOKEN`) is a bearer secret: anyone who has it can send notifications and alarms to your phone. Keep it out of repositories and logs. If it leaks, revoke it in TMGR under Settings → Agent notifications and create a new one.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:
https://github.com/tmgr-dev/tmgr-notify/security/advisories/new

Do not open public issues for security problems.
