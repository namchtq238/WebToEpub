"use strict";

parserFactory.register("global.novelpia.com", () => new GlobalNovelpiaParser());

class GlobalNovelpiaParser extends Parser {
    constructor() {
        super(new GlobalNovelpiaImageCollector());
        this.minimumThrottle = 3000;
    }

    async getChapterUrls(dom) {
        const rows = 9999;
        const sort = "ASC";
        const regex = /\/novel\/(\d+)/;
        const novelId = dom.baseURI.match(regex)?.[0].slice(7);
        const apiUrl = `https://api-global.novelpia.com/v1/novel/episode/cursor-list?novel_no=${novelId}&rows=${rows}&sort=${sort}`;
        try {
            const response = (await HttpClient.fetchJson(apiUrl)).json;
            const data = response.result.list;
            return data.map(chapter => {
                return {
                    sourceUrl: `https://global.novelpia.com/viewer/${chapter.episode_no}`,
                    title: chapter.epi_num + " - " + chapter.epi_title
                };
            });
        } catch (error) {
            ErrorLog.showErrorMessage(error);
        }
    }

    findContent(dom) {
        return Parser.findConstrutedContent(dom);
    }

    extractTitleImpl(dom) {
        return dom.querySelector(".nv-tit");
    }

    extractAuthor(dom) {
        let authorLabel = dom.querySelector(".info-author");
        return authorLabel?.textContent ?? super.extractAuthor(dom);
    }

    extractLanguage(dom) {
        return dom.querySelector("html").getAttribute("lang");
    }

    extractSubject(dom) {
        let tags = [...dom.querySelectorAll(".nv-tag")];
        return tags.map(e => e.textContent.trim()).join(", ");
    }

    extractDescription(dom) {
        return dom.querySelector(".synopsis-text").textContent.trim();
    }

    findChapterTitle(dom) {
        return dom.querySelector(".in-ch-txt");
    }

    findCoverImageUrl(dom) {
        return util.getFirstImgSrc(dom, ".cover-box");
    }

    async fetchChapter(url) {
        let dom = (await HttpClient.fetchHtml(url)).responseXML;
        let chapNumber = dom.querySelector("span.in-chapter-number")?.textContent;
        let chapTitle = dom.querySelector("span.in-chapter-title")?.textContent;
        let token = this.findChapterContentToken(dom);
        let contentUrl = `https://api-global.novelpia.com/v1/novel/episode/content?_t=${token}`;
        let contentJson = (await HttpClient.fetchJson(contentUrl)).json;
        return this.jsonToHtml(url, contentJson.result.data, chapNumber + " - " + chapTitle);
    }

    findChapterContentToken(dom) {
        let regex = new RegExp("eyJhb[^\"]*");
        let getToken = dom.querySelector("script#__NUXT_DATA__")?.outerHTML;
        let chapToken = getToken?.match(regex);
        return chapToken;
    }

    jsonToHtml(pageUrl, data, title) {
        let newDoc = Parser.makeEmptyDocForContent(pageUrl);
        let header = newDoc.dom.createElement("h1");
        header.textContent = title;
        newDoc.content.appendChild(header);
        let fragments = Object.keys(data)
            .filter(k => k.startsWith("epi_content"))
            .map(k => data[k]);
        let content = util.sanitize("<div>" + fragments.join("") + "</div>");
        util.moveChildElements(content.body, newDoc.content);
        return newDoc.dom;
    }

    removeUnwantedElementsFromContentElement(element) {
        util.removeChildElementsMatchingSelector(element, ".next-epi-btn");
        super.removeUnwantedElementsFromContentElement(element);
    }

    getInformationEpubItemChildNodes(dom) {
        return [...dom.querySelectorAll(".nv-synopsis")];
    }

    cleanInformationNode(node) {
        util.removeChildElementsMatchingSelector(node, "button");
        return node;
    }
}

class GlobalNovelpiaImageCollector extends ImageCollector {
    constructor() {
        super();
    }

    async fetchImage(imageInfo, progressIndicator, parentPageUrl) {
        let initialUrl = this.initialUrlToTry(imageInfo);
        if (new URL(initialUrl).hostname !== "pv-gn.novelpia.com") {
            return super.fetchImage(imageInfo, progressIndicator, parentPageUrl);
        }

        try {
            this.urlIndex.set(initialUrl, imageInfo.index);
            let response = await GlobalNovelpiaImageCollector.fetchImageFromTab(initialUrl, parentPageUrl);
            imageInfo.sourceUrl = response.url;
            imageInfo.mediaType = response.contentType;
            imageInfo.arraybuffer = GlobalNovelpiaImageCollector.dataUrlToArrayBuffer(response.dataUrl);
            this.urlIndex.set(response.url, imageInfo.index);
            this.fixupInvalidMediaType(imageInfo);
            {
                let img = await this.getImageDimensions(imageInfo);
                await this.runCompression(imageInfo, img);
            }
            progressIndicator();
            this.addToPackList(imageInfo);
        } catch (error) {
            this.imagesToPack.push(imageInfo);
            ErrorLog.log(error);
        }
    }

    static async fetchImageFromTab(url, parentPageUrl) {
        let tabId = GlobalNovelpiaImageCollector.extractTabIdFromQueryParameter();
        if (tabId == null) {
            throw new Error("Unable to fetch Novelpia image: no source tab id found");
        }
        await GlobalNovelpiaImageCollector.navigateTabToChapter(tabId, parentPageUrl);

        let results;
        try {
            results = await GlobalNovelpiaImageCollector.executeFetchScript(tabId, url, "MAIN");
        } catch (error) {
            results = await GlobalNovelpiaImageCollector.executeFetchScript(tabId, url);
        }
        let result = results?.[0]?.result;
        if (result?.error != null) {
            throw new Error(result.error);
        }
        if (result?.status !== 200) {
            throw new Error(`Fetch of Novelpia image '${url}' failed with network error ${result?.status}`);
        }
        return result;
    }

    static async navigateTabToChapter(tabId, pageUrl) {
        let tab = await chrome.tabs.get(tabId);
        if (!GlobalNovelpiaImageCollector.isTabAtUrl(tab, pageUrl)) {
            let waitForLoad = GlobalNovelpiaImageCollector.waitForTabLoad(tabId, pageUrl);
            await chrome.tabs.update(tabId, {url: pageUrl});
            await waitForLoad;
        } else if (tab.status !== "complete") {
            await GlobalNovelpiaImageCollector.waitForTabLoad(tabId, pageUrl);
        }
    }

    static waitForTabLoad(tabId, expectedUrl) {
        return new Promise((resolve) => {
            let complete = false;
            let timeoutId = null;
            let finish = () => {
                if (!complete) {
                    complete = true;
                    clearTimeout(timeoutId);
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };
            let listener = (updatedTabId, changeInfo, tab) => {
                if (updatedTabId === tabId
                    && changeInfo.status === "complete"
                    && GlobalNovelpiaImageCollector.isTabAtUrl(tab, expectedUrl)) {
                    finish();
                }
            };
            timeoutId = setTimeout(finish, 20000);
            chrome.tabs.onUpdated.addListener(listener);
            chrome.tabs.get(tabId, (tab) => {
                if (tab?.status === "complete"
                    && GlobalNovelpiaImageCollector.isTabAtUrl(tab, expectedUrl)) {
                    finish();
                }
            });
        });
    }

    static isTabAtUrl(tab, expectedUrl) {
        if (tab?.url == null) {
            return false;
        }
        return util.normalizeUrlForCompare(tab.url) === util.normalizeUrlForCompare(expectedUrl);
    }

    static executeFetchScript(tabId, url, world) {
        let options = {
            target: {tabId: tabId},
            args: [url],
            func: async (imageUrl) => {
                try {
                    let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                    for (let i = 0; i < 120; ++i) {
                        let image = [...document.images]
                            .find((img) => img.src === imageUrl || img.currentSrc === imageUrl);
                        if (image != null) {
                            if (image.complete && 0 < image.naturalWidth) {
                                break;
                            }
                            await new Promise((resolve) => {
                                image.addEventListener("load", resolve, {once: true});
                                image.addEventListener("error", resolve, {once: true});
                                setTimeout(resolve, 1000);
                            });
                            break;
                        }
                        await sleep(250);
                    }
                    let response = await fetch(imageUrl, {credentials: "include"});
                    let blob = await response.blob();
                    let dataUrl = await new Promise((resolve, reject) => {
                        let reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = () => reject(reader.error);
                        reader.readAsDataURL(blob);
                    });
                    return {
                        status: response.status,
                        url: response.url,
                        contentType: response.headers.get("content-type") ?? blob.type,
                        dataUrl: dataUrl
                    };
                } catch (error) {
                    return {error: error.message};
                }
            }
        };
        if (world != null) {
            options.world = world;
        }
        return chrome.scripting.executeScript(options);
    }

    static extractTabIdFromQueryParameter() {
        let tabId = new URLSearchParams(window.location.search).get("id");
        return util.isNullOrEmpty(tabId) ? null : parseInt(tabId, 10);
    }

    static dataUrlToArrayBuffer(dataUrl) {
        let base64 = dataUrl.substring(dataUrl.indexOf(",") + 1);
        let binary = atob(base64);
        let bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; ++i) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }
}
