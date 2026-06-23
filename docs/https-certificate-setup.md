# HTTPS certificate setup for Auto by Elvis

The browser warning that says the site does not have a certificate is not caused by the HTML in this repository. It means the hosting provider has not issued or attached a valid TLS/SSL certificate for `autobyelvis.com` yet.

This project is configured for the custom domain in `CNAME`:

```txt
autobyelvis.com
```


## What Chrome can and cannot fix

Chrome cannot create or install a public SSL certificate for `autobyelvis.com`. A public certificate must be issued by the hosting provider or certificate authority after the domain DNS is correct.

You can use Chrome to confirm the problem and refresh cached certificate state:

1. Open `https://autobyelvis.com` in Chrome.
2. Select **Not secure** or the warning icon in the address bar.
3. Select **Certificate is not valid** to view the certificate details.
4. Open **DevTools** with `Ctrl+Shift+I` on Windows/Linux or `Cmd+Option+I` on macOS.
5. Go to the **Security** tab and select **View certificate** to confirm whether Chrome sees a missing, expired, wrong-domain, or untrusted certificate.
6. After DNS and GitHub Pages HTTPS are fixed, restart Chrome or open an Incognito window and test the site again.

Do not tell customers to bypass the Chrome warning for normal use. Bypassing only hides the warning on one device and does not secure visitors, passwords, forms, or payments.

## Fix on GitHub Pages

1. Open the repository on GitHub.
2. Go to **Settings** → **Pages**.
3. Under **Custom domain**, confirm the domain is exactly `autobyelvis.com` and save it if needed.
4. In the DNS control panel for `autobyelvis.com`, point the apex/root domain to GitHub Pages with these `A` records:

   ```txt
   185.199.108.153
   185.199.109.153
   185.199.110.153
   185.199.111.153
   ```

5. Remove conflicting `A`, `AAAA`, or forwarding records for the apex/root domain unless they are intentionally required by the current host.
6. Wait for DNS to propagate, then return to **Settings** → **Pages**.
7. Wait until GitHub shows the domain is checked successfully.
8. Turn on **Enforce HTTPS**.

GitHub Pages can only issue the certificate after DNS points correctly to GitHub Pages. Certificate provisioning can take minutes and sometimes up to 24 hours after DNS is fixed.

## Optional `www` setup

If you also want `www.autobyelvis.com` to work, add this DNS record:

```txt
Type: CNAME
Name: www
Value: ekamaw-ux.github.io
```

Then add or confirm the custom domain in GitHub Pages. GitHub will redirect between the apex domain and `www` depending on the domain saved in the Pages settings.

## Verify after setup

Run these checks after DNS changes have propagated:

```bash
dig +short autobyelvis.com A
curl -I https://autobyelvis.com
```

The `dig` command should return GitHub Pages IP addresses, and the `curl` command should return an HTTPS response without certificate errors.
