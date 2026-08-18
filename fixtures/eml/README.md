# Email fixtures

Drop raw `.eml` files here. Each one becomes the test fixture for the parser
built against it, so parsers are always verified against real mail.

Naming: `<retailer>-<event>-<n>.eml`, for example:

    bol-order-confirmation-1.eml
    bol-cancellation-1.eml
    stockx-sale-1.eml

These files contain real personal data (addresses, order references). They are
git-ignored by default. Remove the ignore rule only if you decide the repository
should carry them.
