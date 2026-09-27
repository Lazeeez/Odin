"""Render web/public/og.png, the link-preview card, from the live page's hero section.

    npm --prefix web run build && npm --prefix web run preview &
    uv run --with playwright python scripts/render_og.py

Needs a Chromium for Playwright (`playwright install chromium`). Re-run after refreshing
web/public/data/, so the card shows current numbers.
"""

from playwright.sync_api import sync_playwright

URL = "http://localhost:4173/"


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 630}, color_scheme="light")
        page.goto(URL)
        page.wait_for_function("document.querySelector('.stat .num')?.textContent.endsWith('%')")
        page.add_style_tag(
            content=".nav{display:none} .hero{padding-top:56px!important} .cta{display:none}"
        )
        page.screenshot(
            path="web/public/og.png", clip={"x": 0, "y": 0, "width": 1200, "height": 630}
        )
        browser.close()


if __name__ == "__main__":
    main()
