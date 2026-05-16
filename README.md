# xkcd-color-language

curated dataset of color terms from XKCD survey

## Install

Use [npm](https://npmjs.com/) to install.

```sh
npm install xkcd-color-language --save
```

## Data Cleaning

A number of efforts have been made to clean the XKCD data. Much of this effort has been manual curation, but I've also passed the data through various LLMs to automatically flag poor responses.

- Removing trolls, vulgarities, spammers, poor quality responses, including filtering out users who would consistently answer with obviously wrong color names (e.g. labelling a clear red color as blue, or vice versa, over many responses)
- Normalising typos and very similar terms to the more popular or more standard term ("robins egg blue" to "robin egg blue")
- Providing a hint for further curation; some terms like "vomit green", "caucasion", "diarrhea" are frequently recorded, but these may not be fit for many user-facing applications, and so some of them have been marked with a hint allowing them to be included/ignored depending on the use case.

## Using the Raw Data

The raw XKCD survey data has over 3M records and hundreds of thousands of unique color names. However, there is a lot of spam, typos, troll responses, and so on. Although this repo distributes a very short list of terms, you can get access to the 'cleaned' data using the steps below, which gives you 90K+ color terms, each with their associated RGB value. This may be useful for data mining. The top-voted 5000 color names should be fairly decent, but after that there will be a long tail of typos, poor responses, and potentially some vulgarities. For data mining, you might want to use a minimum vote, such as ~20, and you may also want to filter outliers

### Download Files and Clean

Download the [CSV files](https://drive.google.com/drive/folders/1eptbvVtgalKMYuSuZNOZBk1XKh0rqljF?usp=sharing) (`answers.csv` and `users.csv`) and save them in the `data/xkcd` folder, then run:

```sh
node src/clean-data.js
```

You can include `--skip-color-blind` or `--skip-non-english` options, but note that you may lose some valuable data, as for example many users will put another language even if they answer in English. For the distribution files, I've left these filters disabled. You can include `--debug` to see what top-voted terms were culled.

This will render `data/xkcd/answers.compact.json` which is an array of 3 or 4 element arrays:

```json
[ userId, rgbInt, name, originalName ]
```

If `name === originalName` (no cleaning was needed) the array will omit the last element, to make the file smaller overall.

### How the CSV Was Generated

The above CSV files was generated from the SQLite data dump. Conversion can be done like so:

1. Download the SQLite text dump from the [blog post](https://blog.xkcd.com/2010/05/03/color-survey-results/) or the [direct link to XKCD-hosted .tar.gz file](here), or my own [mirror](https://drive.google.com/file/d/1H9XKXXeJus-vzd0NgYrHVU0TFh98iiAd/view?usp=sharing).

2. Conver the TXT file of the main survey to a SQLite DB:

```sh
sqlite3 main.db < mainsurvey_sqldump.txt
```

3. Open it:

```sh
sqlite3 main.db
```

4. Convert to CSV:

```sh
.mode csv
.headers on

.output users.csv
SELECT * FROM users;

.output answers.csv
SELECT * FROM answers;

.output stdout
.quit
```

You should now have `users.csv` and `answers.csv`.

## Interesting Colors

- murex
- hooloovoo
- blue screen of death
- od green
- hr block green
- ups brown

## Usage

[![NPM](https://nodei.co/npm/xkcd-color-language.png)](https://www.npmjs.com/package/xkcd-color-language)

## License

MIT, see [LICENSE.md](http://github.com/mattdesl/xkcd-color-language/blob/master/LICENSE.md) for details.
