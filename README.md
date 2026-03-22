# MultiPass — GitHub Pages Wrapper

Static iframe wrapper for the MultiPass GAS web app. Provides:
- Clean URL for sharing on Facebook (`spm-apa.github.io/multipass`)
- Open Graph meta tags for rich link previews
- Loading splash while GAS initializes
- Mobile-friendly fullscreen iframe

## Setup

1. Create GitHub org `spm-apa`
2. Create repo `multipass` under that org
3. Push this folder's contents to the `main` branch
4. Enable GitHub Pages: Settings → Pages → Source: `main` / `/ (root)`
5. Generate `og-image.png`: open `generate-og-image.html` in a browser, right-click canvas → Save as `og-image.png`
6. Commit and push `og-image.png`

## Facebook Sharing

After deploying, paste the URL into Facebook's [Sharing Debugger](https://developers.facebook.com/tools/debug/)
to force it to scrape the OG tags. Then share the link in your Facebook group.

## Custom Domain (optional)

To use a custom domain like `play.spmapa.com`:
1. Add a `CNAME` file with your domain
2. Configure DNS (CNAME record pointing to `spm-apa.github.io`)
3. Enable HTTPS in GitHub Pages settings
