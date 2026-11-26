import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {startMockServer} from '../scripts/serve-onboarding-mock.mjs';

async function withServer(zip, run) {
  const server = await startMockServer({port: 0, zip});
  try {
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    server.close();
  }
}

async function expectNoAxeViolations(page) {
  // Triaged: tab radios use one aria-label ("Launch: Get your business online") and hide the
  // duplicate visible words so a screen reader announces each tab once. Axe treats that as a
  // label/content mismatch. The targeted radio-name assertions cover the intended announcement.
  const results = await new AxeBuilder({page}).disableRules(['label-content-name-mismatch']).analyze();
  expect(results.violations.map(item => item.id + ': ' + item.help)).toEqual([]);
}

test('ZIP-off landing names each control once and hides inactive panels', async ({page}) => {
  await withServer(false, async base => {
    await page.goto(base + '/');
    await expectNoAxeViolations(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', {name: 'Skip to content'})).toBeFocused();
    const launch = page.getByRole('radio', {name: 'Launch: Get your business online'});
    await launch.focus();
    await expect(launch).toBeChecked();
    await expect(page.getByRole('group', {name: 'Choose what to explore'})).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', {name: 'Maintain: Make changes. Just ask.'})).toBeChecked();
    await expect(page.locator('.lo-p-launch')).toBeHidden();
    await expect(page.getByText('Available with your own tools')).toBeVisible();
    await expect(page.locator('.lo-p-maintain').getByText('Planned · not released', {exact: true})).toBeVisible();
    await expect(page.getByText('Planned · not released · created only by you')).toBeHidden();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', {name: 'Grow: Grow beyond a website'})).toBeChecked();
    await expect(page.locator('.lo-p-maintain')).toBeHidden();
    await expect(page.getByText('Planned · not released · created only by you')).toBeVisible();
  });
});

test('ZIP-on landing uses the upload wording', async ({page}) => {
  await withServer(true, async base => {
    await page.goto(base + '/');
    await expect(page.getByText('Build anywhere. Own everything.')).toBeVisible();
    await expect(page.getByRole('link', {name: 'Bring my website'}).first()).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test('mocked consent reaches preview, toolkit tabs, history, and logout', async ({page}) => {
  await withServer(false, async base => {
    await page.goto(base + '/');
    await page.getByRole('link', {name: 'Connect GitHub'}).click();
    await expect(page.getByText('GitHub connected: tester')).toBeVisible();
    await page.getByRole('link', {name: 'Connect Cloudflare'}).click();
    await page.getByLabel('Cloudflare account').selectOption({label: 'Demo Account'});
    await page.getByRole('button', {name: 'Use this account'}).click();
    await expect(page.getByText('Cloudflare connected · hosting account selected')).toBeVisible();
    await page.getByLabel('Business or website name').fill('Willow Studio');
    await page.getByLabel('Homepage headline').fill('Portraits with care');
    await page.getByLabel('Describe your business').fill('Family portraits in town.');
    await page.getByRole('button', {name: 'Preview my website'}).click();
    await expect(page.getByRole('button', {name: 'Approve and create website'})).toBeVisible();
    await expect(page.getByText('Website name: Willow Studio')).toBeVisible();
    const previewPath = await page.getByRole('link', {name: 'Open the exact preview'}).getAttribute('href');
    await page.goto(base + previewPath);
    await expect(page.getByText('Portraits with care')).toBeVisible();
    await page.goBack();
    await expectNoAxeViolations(page);
    await page.getByRole('button', {name: 'Approve and create website'}).click();
    await page.goto(base + '/history');
    await expect(page.getByText('Willow Studio')).toBeVisible();
    await page.goto(base + '/toolkit');
    const overview = page.getByRole('radio', {name: 'Overview'});
    await expect(overview).toBeChecked();
    await expect(page.getByRole('group', {name: 'Sections for Willow Studio'})).toBeVisible();
    await overview.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', {name: 'Updates'})).toBeChecked();
    await expect(page.locator('.tk-p-overview')).toBeHidden();
    await expect(page.locator('.tk-p-updates')).toBeVisible();
    await expectNoAxeViolations(page);
    await page.goto(base + '/');
    await page.getByRole('button', {name: 'Disconnect and sign out'}).click();
    await expect(page.getByRole('link', {name: 'Connect GitHub'})).toBeVisible();
  });
});
