# DNS Cache Recovery - Thu Jun 11 17:35:40 IST 2026

## Recovery Attempt Results

Queried 4 major public DNS resolvers for cached DNS records:
- Google (8.8.8.8)
- Cloudflare (1.1.1.1)
- Quad9 (9.9.9.9)
- OpenDNS (208.67.222.222)

### Records Queried

1. TXT google._domainkey.margenticos.com - **NO CACHE** (all 4 resolvers)
2. TXT margenticos.com (SPF) - **NO CACHE** (all 4 resolvers)
3. TXT _dmarc.margenticos.com - **NO CACHE** (all 4 resolvers)
4. TXT resend._domainkey.notifications.margenticos.com - **NO CACHE** (all 4 resolvers)
5. MX margenticos.com - **NO CACHE** (all 4 resolvers)
6. MX send.notifications.margenticos.com - **NO CACHE** (all 4 resolvers)
7. TXT send.notifications.margenticos.com (SPF) - **NO CACHE** (all 4 resolvers)

## Recovery Summary

**Total records recovered: 0 of 7**

None of the deleted DNS records were found in any of the 4 major public resolver caches. This indicates the TTLs were either very short or the caches do not have these records.

## Recoverable Values (from earlier data and user specifications)

Known values that can be restored without querying:
- _dmarc.margenticos.com TXT: `v=DMARC1; p=none;`
- send.notifications.margenticos.com MX: feedback-smtp.eu-west-1.amazonses.com (priority 10)
- send.notifications.margenticos.com TXT: `v=spf1 include:amazonses.com ~all`
- app.margenticos.com A: 76.76.21.21
- margenticos.com A: 216.198.79.1
- www.margenticos.com CNAME: 49d925d3cb223068.vercel-dns-017.com

## Lost Values (Must be re-fetched from admin consoles)

- google._domainkey.margenticos.com TXT (Google DKIM) - **LOST**
- resend._domainkey.notifications.margenticos.com TXT (Resend DKIM) - **LOST**
- margenticos.com TXT google-site-verification (Google verification) - **LOST**

---

## Resend DNS Records (Recovered via API)

Successfully retrieved from Resend API (margenticos.com domain):

### DKIM (resend._domainkey.margenticos.com)
Type: TXT
Name: resend._domainkey
Value: p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCtKJma4IRksoOp0f1fM9p+x0bjEezwE690BSuJcTLXKJTnVkQtGIoOsOMNIKg+mfDByEldYWmFZ59YPJa8BCCVYOhfQRtcnlcqHao1dr11UV4cQrFWzuORhxRhAmD2hXfheMmUAh1tR9eWMS2k7kFOLFXN2uG9ruvbtIKXR2gGQQIDAQAB
Status: verified

### SES MX (send.margenticos.com)
Type: MX
Name: send
Value: feedback-smtp.eu-west-1.amazonses.com
Priority: 10
Status: verified

### SES SPF (send.margenticos.com)
Type: TXT
Name: send
Value: v=spf1 include:amazonses.com ~all
Status: verified
