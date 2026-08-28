# curl here is built against mbedTLS with no compiled-in CA path, so point it
# (and other TLS tools) at the ca-certificates bundle explicitly. Without this
# `curl https://...` fails with "certificate is not correctly signed by the
# trusted CA" even though the bundle is installed.
export CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_DIR=/etc/ssl/certs
