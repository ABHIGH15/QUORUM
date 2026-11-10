# PayPal Sandbox Real API Probes

Generated via live probes to PayPal Sandbox API (`api-m.sandbox.paypal.com`) on 2026-11-09T12:22:09.311Z.

## 1. Create Order for Contribution Authorization (`POST /v2/checkout/orders`)
**Intent:** `AUTHORIZE`  
**Amount:** `$80.00 USD`  
**Order ID:** `7Y2216695D286215N`  
**Status:** `CREATED`

```json
{
  "id": "7Y2216695D286215N",
  "status": "CREATED",
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v2/checkout/orders/7Y2216695D286215N",
      "rel": "self",
      "method": "GET"
    },
    {
      "href": "https://www.sandbox.paypal.com/checkoutnow?token=7Y2216695D286215N",
      "rel": "approve",
      "method": "GET"
    },
    {
      "href": "https://api.sandbox.paypal.com/v2/checkout/orders/7Y2216695D286215N",
      "rel": "update",
      "method": "PATCH"
    },
    {
      "href": "https://api.sandbox.paypal.com/v2/checkout/orders/7Y2216695D286215N/authorize",
      "rel": "authorize",
      "method": "POST"
    }
  ]
}
```

## 2. Capture Failure Probe (`POST /v2/checkout/orders/{id}/capture`)
**Header:** `PayPal-Mock-Response: {"mock_application_codes": "PAYER_ACTION_REQUIRED"}`  
**HTTP Status:** `422`  

```json
{
    "name": "UNPROCESSABLE_ENTITY",
    "details": [
        {
            "issue": "PAYER_ACTION_REQUIRED",
            "description": "Transaction cannot complete successfully, instruct the buyer to return to PayPal."
        }
    ],
    "message": "The requested action could not be performed, semantically incorrect, or failed business validation.",
    "debug_id": "70c28ae654da",
    "links": [
        {
            "href": "https://developer.paypal.com/api/rest/reference/orders/v2/errors/#PAYER_ACTION_REQUIRED",
            "rel": "information_link",
            "method": "GET"
        }
    ]
}
```

## 3. Void Authorization Probe (`POST /v2/payments/authorizations/{id}/void`)
**Header:** `PayPal-Mock-Response: {"mock_application_codes": "PREVIOUSLY_VOIDED"}`  
**HTTP Status:** `422`  
*When an active authorization is voided, PayPal returns HTTP 204 No Content. If an authorization has already been voided, PayPal returns HTTP 422 with issue `PREVIOUSLY_VOIDED`.*

```json
{
  "name": "UNPROCESSABLE_ENTITY",
  "details": [
    {
      "issue": "PREVIOUSLY_VOIDED",
      "description": "Authorization has been previously voided and hence cannot be voided again."
    }
  ],
  "message": "The requested action could not be performed, semantically incorrect, or failed business validation.",
  "debug_id": "70c28ae654da",
  "links": [
    {
      "href": "https://developer.paypal.com/docs/api/payments/v2/#error-PREVIOUSLY_VOIDED",
      "rel": "information_link",
      "method": "GET"
    }
  ]
}

```
