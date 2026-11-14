## foundation-repo-dashboard

### Overview:

- This project collects Cucumber JSON reports from configured GitHub repositories and combines their scenarios into one Allure dashboard;
- Each Allure scenario includes its repository, feature, tags, step and hook results, failure details, and a link to the source Actions run;
- The dashboard is published to GitHub Pages once per day and can also be generated manually from the Actions tab.

### Requirements

- Node.js (22 or above);
- Java (17 or above) to run the Allure command-line report generator;
- GitHub Pages configured to use **GitHub Actions** as the deployment source.

### Guidelines:

- Local Dashboard:
  - Run `node dist/build-dashboard.js --config config.properties --output allure-results` after `npm test` to collect reports and create Allure result files;
  - Install Allure CLI `2.34.1`, then run `allure generate allure-results --clean --output site` to generate the static dashboard.

### Dashboard Data Flow

1. The scheduled or manually dispatched workflow checks formatting, tests and compiles the collector;
2. The collector reads `config.properties` and finds the latest completed run on each configured branch and workflow;
3. It downloads the configured artifact from each run and selects Cucumber JSON files matching that repository's `cucumber` glob;
4. Cucumber scenarios are converted to Allure results, including scenario status, step and hook details, tags, and source-run links;
5. Allure CLI generates a static site, which the workflow publishes to GitHub Pages.

### Configuration

[`config.properties`](config.properties) defines the repositories, workflow runs, artifacts, and report files. Add an identifier to the comma-separated `repositories` property, then configure its fields:

- `owner` and `repo`: GitHub repository owner and repository name;
- `branch`: branch from which to select the latest completed workflow run;
- `workflow`: workflow file name or ID;
- `artifact`: artifact name to download from that run;
- `cucumber`: comma-separated glob pattern(s), relative to the artifact root, identifying Cucumber JSON files.

### Key Components

- TypeScript - Implements the report collector and converts Cucumber JSON into Allure results;
- Allure - Generates the combined test report as a static website;
- GitHub Pages - Hosts the generated dashboard.

### Documentation

- Allure - https://allurereport.org/docs/

### FAQ / Troubleshooting

- Why does artifact download fail with HTTP 401?
  - Add a fine-grained personal access token as the `REPORTS_READ_TOKEN` Actions repository secret;
  - Grant it **Actions: Read-only** access to every repository listed in `config.properties`.
- Where is the published dashboard?
  - Enable GitHub Pages with **GitHub Actions** as the source, then open the Pages URL shown in the `Deploy to GitHub Pages` workflow job.
