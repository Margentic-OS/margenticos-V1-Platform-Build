#!/bin/bash
set -e

ZONE_ID="69d56b71b4981c20806bb5aa"
DKIM_VALUE="v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyPHg3GZf7yc0wIbmdzFkz4iAboRtvpJB6YvegubsteDxGudNMPLSadQ+RqVBNmD74MDeOZxMbfrfR7g4v/gF32EOfjU+u70QyPmCsbZ1YKT+4b0EnStI5zSj4Hm9jXGQyCTcuR/Pnad61jAIgJH1etF7Nlk1I/J8xRk4h88NLLzpa4Fkp6se4clhD0A3Stbw4AJ/3fZucboDWALUN5p2x76H9/YDmWKxAZ51UPe0HQgWyZjVASG6phpO1h/tyZa1T/Yn5xEEK6tGA/MKqEtfZ7F7nMyJS0rv2dLqFpkPuUqyYxMxgbsZlxCqyfzafpVSWsG93PP2tg/oDUwtpcx17wIDAQAB"
DMARC_OLD_ID="69e90aa5216d9a0faca313d2"
DKIM_OLD_ID="69d6b46f0d0e20441484230a"

if [ -z "$NETLIFY_AUTH_TOKEN" ]; then
  echo "Error: NETLIFY_AUTH_TOKEN environment variable not set"
  exit 1
fi

API_URL="https://api.netlify.com/api/v1"
AUTH_HEADER="Authorization: Bearer $NETLIFY_AUTH_TOKEN"

echo "Step 1: Checking existing DKIM record ($DKIM_OLD_ID)..."
DKIM_RECORD=$(curl -s -H "$AUTH_HEADER" "$API_URL/dns_zones/$ZONE_ID/dns_records/$DKIM_OLD_ID")
DKIM_HOSTNAME=$(echo "$DKIM_RECORD" | jq -r '.hostname')
DKIM_TYPE=$(echo "$DKIM_RECORD" | jq -r '.type')
DKIM_VALUE_CURRENT=$(echo "$DKIM_RECORD" | jq -r '.value')

echo "Hostname: $DKIM_HOSTNAME"
echo "Type: $DKIM_TYPE"
echo "Value: $DKIM_VALUE_CURRENT"
echo ""

if [ "$DKIM_HOSTNAME" = "google._domainkey.margenticos.com" ]; then
  echo "Deleting stale DKIM record ($DKIM_OLD_ID)..."
  curl -s -H "$AUTH_HEADER" -X DELETE "$API_URL/dns_zones/$ZONE_ID/dns_records/$DKIM_OLD_ID"
  echo "Record deleted."
  echo ""
else
  echo "LEAVING RECORD ALONE: $DKIM_HOSTNAME"
  echo ""
fi

echo "Step 2: Creating root SPF record..."
SPF_RESPONSE=$(curl -s -H "$AUTH_HEADER" \
  -X POST -H "Content-Type: application/json" \
  "$API_URL/dns_zones/$ZONE_ID/dns_records" \
  -d '{"hostname":"margenticos.com","type":"TXT","ttl":3600,"value":"v=spf1 include:_spf.google.com ~all"}')
echo "$SPF_RESPONSE" | jq '.'
echo ""

echo "Step 3: Creating Google DKIM record..."
DKIM_RESPONSE=$(curl -s -H "$AUTH_HEADER" \
  -X POST -H "Content-Type: application/json" \
  "$API_URL/dns_zones/$ZONE_ID/dns_records" \
  -d "{\"hostname\":\"google._domainkey.margenticos.com\",\"type\":\"TXT\",\"ttl\":3600,\"value\":\"$DKIM_VALUE\"}")
echo "$DKIM_RESPONSE" | jq '.'
echo ""

echo "Step 4a: Deleting old DMARC record ($DMARC_OLD_ID)..."
curl -s -H "$AUTH_HEADER" -X DELETE "$API_URL/dns_zones/$ZONE_ID/dns_records/$DMARC_OLD_ID"
echo "Record deleted."
echo ""

echo "Step 4b: Creating new DMARC record..."
DMARC_RESPONSE=$(curl -s -H "$AUTH_HEADER" \
  -X POST -H "Content-Type: application/json" \
  "$API_URL/dns_zones/$ZONE_ID/dns_records" \
  -d '{"hostname":"_dmarc.margenticos.com","type":"TXT","ttl":3600,"value":"v=DMARC1; p=quarantine; rua=mailto:doug@margenticos.com; pct=100"}')
echo "$DMARC_RESPONSE" | jq '.'
echo ""

echo "Waiting 60 seconds for DNS propagation..."
sleep 60

echo "Step 5: Verifying DNS records..."
echo ""
echo "margenticos.com TXT records:"
dig margenticos.com TXT +short
echo ""
echo "google._domainkey.margenticos.com TXT records:"
dig google._domainkey.margenticos.com TXT +short
echo ""
echo "_dmarc.margenticos.com TXT records:"
dig _dmarc.margenticos.com TXT +short
echo ""

echo "DONE"
