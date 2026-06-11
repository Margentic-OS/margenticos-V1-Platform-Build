# DNS Zone Snapshot — margenticos.com

**Date:** 2026-06-11 (Post-recovery from incident)
**Authoritative Nameservers:** ns1.vercel-dns.com, ns2.vercel-dns.com
**Previous State:** Netlify NSOne zone (dns1-4.p08.nsone.net) — DELETED due to margentic-survey project removal

## Complete Record Set

```
margenticos.com
                                   id    name                        type     value                                                                                                                                                                                                                                                                                                                                                                                                                               created    
         rec_cafe92e95d97b939677cf5d3    google._domainkey           TXT      v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyPHg3GZf7yc0wIbmdzFkz4iAboRtvpJB6YvegubsteDxGudNMPLSadQ+RqVBNmD74MDeOZxMbfrfR7g4v/gF32EOfjU+u70QyPmCsbZ1YKT+4b0EnStI5zSj4Hm9jXGQyCTcuR/Pnad61jAIgJH1etF7Nlk1I/J8xRk4h88NLLzpa4Fkp6se4clhD0A3Stbw4AJ/3fZucboDWALUN5p2x76H9/YDmWKxAZ51UPe0HQgWyZjVASG6phpO1h/tyZa1T/Yn5xEEK6tGA/MKqEtfZ7F7nMyJS0rv2dLqFpkPuUqyYxMxgbsZlxCqyfzafpVSWsG93PP2tg/oDUwtpcx17wIDAQAB          5h ago     
         rec_35e9f5f517f0e297378e044d                                TXT      google-site-verification=MEb21ayr9CtPl3KU3UDoh36p9S09wlWtQVY9qn1DznE                                                                                                                                                                                                                                                                                                                                                                5h ago     
         rec_265ee15e00cff1c8fc4e6af7    _dmarc                      TXT      v=DMARC1; p=quarantine; rua=mailto:doug@margenticos.com; pct=100                                                                                                                                                                                                                                                                                                                                                                    5h ago     
         rec_88d475a65253a063b7ce37d5    send                        MX       10 feedback-smtp.eu-west-1.amazonses.com.                                                                                                                                                                                                                                                                                                                                                                                           5h ago     
         rec_f7bad5b319a32d94a08bc0b2    send                        TXT      v=spf1 include:amazonses.com ~all                                                                                                                                                                                                                                                                                                                                                                                                   5h ago     
         rec_42fa9cd79456123847f7b65f    resend._domainkey           TXT      p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCtKJma4IRksoOp0f1fM9p+x0bjEezwE690BSuJcTLXKJTnVkQtGIoOsOMNIKg+mfDByEldYWmFZ59YPJa8BCCVYOhfQRtcnlcqHao1dr11UV4cQrFWzuORhxRhAmD2hXfheMmUAh1tR9eWMS2k7kFOLFXN2uG9ruvbtIKXR2gGQQIDAQAB                                                                                                                                                                                                          5h ago     
         rec_a0e02090e8c89a715e3039ff    send.notifications          TXT      v=spf1 include:amazonses.com ~all                                                                                                                                                                                                                                                                                                                                                                                                   5h ago     
         rec_505c55d531901ad9f654d28b    send.notifications          MX       10 feedback-smtp.eu-west-1.amazonses.com.                                                                                                                                                                                                                                                                                                                                                                                           5h ago     
         rec_626eea4fde8603b79649f117                                TXT      v=spf1 include:_spf.google.com ~all                                                                                                                                                                                                                                                                                                                                                                                                 5h ago     
         rec_d6d8c431f5088f89b4e00aa4                                MX       1 smtp.google.com.                                                                                                                                                                                                                                                                                                                                                                                                                  5h ago     
                                                                     CAA      0 issue "pki.goog"                                                                                                                                                                                                                                                                                                                                                                                                                  default    
                                                                     CAA      0 issue "sectigo.com"                                                                                                                                                                                                                                                                                                                                                                                                               default    
                                                                     CAA      0 issue "letsencrypt.org"                                                                                                                                                                                                                                                                                                                                                                                                           default    
                                         *                           ALIAS    cname.vercel-dns-017.com.                                                                                                                                                                                                                                                                                                                                                                                                           default    
                                                                     ALIAS    49d925d3cb223068.vercel-dns-017.com                                                                                                                                                                                                                                                                                                                                                                                                 default    
```

## Critical Records (Verified)

| Record | Type | Value | Status |
|--------|------|-------|--------|
| @ | MX | 1 smtp.google.com | ✅ Email |
| @ | TXT (SPF) | v=spf1 include:_spf.google.com ~all | ✅ Email |
| @ | A | 216.198.79.1 (via project) | ✅ Website |
| www | CNAME | 49d925d3cb223068.vercel-dns-017.com | ✅ Website |
| app | A | 216.198.79.1 (via project) | ✅ Platform |
| _dmarc | TXT | v=DMARC1; p=quarantine; rua=mailto:doug@... | ✅ Email Policy |
| google._domainkey | TXT | v=DKIM1; k=rsa; p=... | ✅ Google DKIM |
| resend._domainkey | TXT | p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ... | ✅ Resend DKIM |
| send.notifications | MX | 10 feedback-smtp.eu-west-1.amazonses.com | ✅ SES |
| send.notifications | TXT | v=spf1 include:amazonses.com ~all | ✅ SES SPF |
| send | MX | 10 feedback-smtp.eu-west-1.amazonses.com | ✅ SES |
| send | TXT | v=spf1 include:amazonses.com ~all | ✅ SES SPF |

## Propagation Status

- **DNS Flipped:** 2026-06-11 17:51 (Namecheap)
- **Website Live:** 2026-06-11 18:02 (10 minutes)
- **All Services Live:** 2026-06-11 18:11 (20 minutes)
- **Resend Verified:** ✅ Sending enabled
- **Certifications:** ✅ All valid

## Next Recovery Step

Any future DNS change must refresh this snapshot:
```
vercel dns ls margenticos.com > docs/dns-zone-snapshot-YYYY-MM-DD.md
git add docs/dns-zone-snapshot-YYYY-MM-DD.md
git commit -m "docs: dns zone snapshot after [change description]"
```

This record ensures the zone state is never lost again.
