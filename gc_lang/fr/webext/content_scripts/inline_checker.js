// JavaScript

/* jshint esversion:6, -W097 */
/* jslint esversion:6 */
/* global oGrammalecte, oGrammalecteBackgroundPort, bChrome, browser, showError, window, document */

"use strict";

/*
    Soulignage direct des erreurs dans les zones de texte enrichi (contentEditable),
    sans passer par le panneau Grammalecte : le texte n'est jamais copié ailleurs,
    on superpose juste des petits calques visuels (des <div> positionnés en absolu)
    par-dessus le texte réel, calculés via Range.getClientRects(). Le contenu du
    champ n'est donc jamais modifié, sauf quand l'utilisateur clique explicitement
    sur une suggestion.

    Limites connues (portée volontairement réduite pour une première version) :
    - Seulement les nœuds contentEditable (pas les <textarea>/<input>, qui
      demanderaient un calque miroir en plus, plus fragile).
    - Un seul "champ actif" à la fois (celui suivi par GrammalecteButton).
    - Si une nouvelle vérification est lancée avant la fin de la précédente
      (frappe rapide), les résultats peuvent brièvement se mélanger — se corrige
      seul au prochain cycle.
*/

const oInlineChecker = {

    nNextId: 0,

    oState: new WeakMap(), // xNode -> { aCharMap, aParaStart, aPendingResults, aHighlights, nDebounceTimer }

    xMenu: null,
    oIgnoredWords: null, // Set, chargé une fois depuis browser.storage.local (clé partagée avec le panneau : "ignored_words")

    _getState (xNode) {
        if (!this.oState.has(xNode)) {
            this.oState.set(xNode, { aCharMap: [], aParaStart: [], aPendingResults: [], aHighlights: [], nDebounceTimer: null });
            xNode.addEventListener("GrammalecteResult", (xEvent) => { this._onResult(xNode, xEvent); });
        }
        return this.oState.get(xNode);
    },

    _loadIgnoredWords () {
        if (this.oIgnoredWords !== null) {
            return;
        }
        this.oIgnoredWords = new Set();
        const setResult = (oResult) => {
            if (oResult.hasOwnProperty("ignored_words")) {
                this.oIgnoredWords = new Set(oResult.ignored_words);
            }
        };
        if (bChrome) {
            browser.storage.local.get("ignored_words", setResult);
        } else {
            browser.storage.local.get("ignored_words").then(setResult, showError);
        }
    },

    scheduleCheck (xNode) {
        this._loadIgnoredWords();
        let oData = this._getState(xNode);
        window.clearTimeout(oData.nDebounceTimer);
        oData.nDebounceTimer = window.setTimeout(() => { this.check(xNode); }, 1200);
    },

    check (xNode) {
        try {
            let oData = this._getState(xNode);
            let { sText, aCharMap, aParaStart } = this._extractTextAndMap(xNode);
            if (sText.trim() === "") {
                this._clearHighlights(xNode);
                return;
            }
            oData.aCharMap = aCharMap;
            oData.aParaStart = aParaStart;
            oData.aPendingResults = [];
            if (!xNode.id) {
                xNode.id = "grammalecte_inline_target_" + (this.nNextId++);
            }
            oGrammalecteBackgroundPort.parseAndSpellcheck(sText, xNode.id);
        }
        catch (e) {
            showError(e);
        }
    },

    _onResult (xNode, xEvent) {
        try {
            let oData = JSON.parse(xEvent.detail);
            if (oData.sType === "proofreading") {
                if (oData.oResult === null) {
                    // bEnd: tous les paragraphes ont été reçus
                    this._draw(xNode);
                } else {
                    this._getState(xNode).aPendingResults.push(oData.oResult);
                }
            }
            else if (oData.sType === "spellsugg") {
                this._onSpellSugg(xNode, oData.oResult);
            }
        }
        catch (e) {
            showError(e);
        }
    },

    // Les suggestions orthographiques n'arrivent pas avec l'erreur : on les
    // demande à la volée seulement quand l'utilisateur ouvre le menu (comme
    // le fait le panneau Grammalecte), pour ne pas les calculer pour rien.
    _onSpellSugg (xNode, oResult) {
        if (!this._oCurrentMenuHighlight || this._oCurrentMenuNode !== xNode) {
            return;
        }
        if (oResult.sWord.toLowerCase() !== this._oCurrentMenuHighlight.xRange.toString().toLowerCase()) {
            return;
        }
        if (!this._xMenuSuggList) {
            return;
        }
        if (this._xMenuSuggList.dataset.empty === "true") {
            this._xMenuSuggList.textContent = "";
            this._xMenuSuggList.dataset.empty = "false";
        }
        for (let sSugg of oResult.aSugg) {
            this._xMenuSuggList.appendChild(this._createSuggestionItem(sSugg, this._oCurrentMenuHighlight.xRange));
        }
    },

    // Aplatit le texte du nœud en une seule chaîne, avec une correspondance
    // [caractère de la chaîne] -> [nœud texte réel + décalage] pour pouvoir,
    // une fois les erreurs reçues, reconstruire une Range DOM précise.
    _extractTextAndMap (xNode) {
        let sText = "";
        let aCharMap = [];
        const BLOCK_TAGS = new Set(["DIV", "P", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);

        const walk = (xElem, bFirstChild) => {
            if (xElem.nodeType === Node.TEXT_NODE) {
                for (let i = 0; i < xElem.textContent.length; i++) {
                    sText += xElem.textContent[i];
                    aCharMap.push({ xTextNode: xElem, iOffset: i });
                }
                return;
            }
            if (xElem.nodeType !== Node.ELEMENT_NODE) {
                return;
            }
            if (xElem.tagName === "BR") {
                sText += "\n";
                aCharMap.push(null);
                return;
            }
            let bBlock = BLOCK_TAGS.has(xElem.tagName);
            if (bBlock && !bFirstChild && sText !== "" && !sText.endsWith("\n")) {
                sText += "\n";
                aCharMap.push(null);
            }
            let xChild = xElem.firstChild;
            let bFirst = true;
            while (xChild) {
                walk(xChild, bFirst);
                bFirst = false;
                xChild = xChild.nextSibling;
            }
        };
        walk(xNode, true);

        let aParaStart = [];
        let nOffset = 0;
        for (let sPart of sText.split("\n")) {
            aParaStart.push(nOffset);
            nOffset += sPart.length + 1;
        }
        return { sText, aCharMap, aParaStart };
    },

    _draw (xNode) {
        let oData = this._getState(xNode);
        this._clearHighlights(xNode);
        for (let oPara of oData.aPendingResults) {
            let nBase = oData.aParaStart[oPara.iParaNum] || 0;
            for (let oErr of oPara.aGrammErr) {
                this._addHighlight(xNode, nBase + oErr.nStart, nBase + oErr.nEnd, oErr, "grammar");
            }
            for (let oErr of oPara.aSpellErr) {
                if (this.oIgnoredWords.has(oErr.sValue ? oErr.sValue.toLowerCase() : "")) {
                    continue;
                }
                this._addHighlight(xNode, nBase + oErr.nStart, nBase + oErr.nEnd, oErr, "spelling");
            }
        }
    },

    _buildRange (xNode, nStart, nEnd) {
        let oData = this._getState(xNode);
        let aMap = oData.aCharMap;
        if (nStart < 0 || nEnd > aMap.length || nStart >= nEnd) {
            return null;
        }
        // on ignore les positions "\n" synthétiques (null) en resserrant les bords
        while (nStart < nEnd && aMap[nStart] === null) { nStart++; }
        while (nEnd > nStart && aMap[nEnd - 1] === null) { nEnd--; }
        if (nStart >= nEnd) {
            return null;
        }
        let oStart = aMap[nStart];
        let oEnd = aMap[nEnd - 1];
        if (!oStart || !oEnd) {
            return null;
        }
        try {
            let xRange = document.createRange();
            xRange.setStart(oStart.xTextNode, oStart.iOffset);
            xRange.setEnd(oEnd.xTextNode, oEnd.iOffset + 1);
            return xRange;
        }
        catch (e) {
            return null;
        }
    },

    _addHighlight (xNode, nStart, nEnd, oErr, sKind) {
        let xRange = this._buildRange(xNode, nStart, nEnd);
        if (!xRange) {
            return;
        }
        let oHighlight = { xNode, xRange, oErr, sKind, aDivs: [] };
        this._getState(xNode).aHighlights.push(oHighlight);
        this._repositionHighlight(oHighlight);
    },

    _colorFor (oErr, sKind) {
        if (sKind === "spelling") {
            return "hsl(0, 100%, 50%)";
        }
        if (oErr.aColor && Array.isArray(oErr.aColor) && oErr.aColor.length === 3) {
            let [h, s, l] = oErr.aColor;
            return `hsl(${h}, ${s}%, ${l}%)`;
        }
        return "hsl(0, 0%, 50%)";
    },

    _repositionHighlight (oHighlight) {
        let aRects = Array.from(oHighlight.xRange.getClientRects());
        // ajuste le nombre de <div> au nombre de rectangles (un mot peut être coupé sur 2 lignes)
        while (oHighlight.aDivs.length > aRects.length) {
            oHighlight.aDivs.pop().remove();
        }
        while (oHighlight.aDivs.length < aRects.length) {
            let xDiv = document.createElement("div");
            xDiv.className = "grammalecte_inline_mark";
            xDiv.style.position = "absolute";
            xDiv.style.pointerEvents = "auto";
            xDiv.style.cursor = "pointer";
            xDiv.style.background = "transparent";
            xDiv.style.zIndex = "2147483000";
            xDiv.addEventListener("contextmenu", (xEvent) => {
                xEvent.preventDefault();
                this._showMenu(xEvent.clientX, xEvent.clientY, oHighlight);
            });
            this._ensureOverlayRoot().appendChild(xDiv);
            oHighlight.aDivs.push(xDiv);
        }
        let sColor = this._colorFor(oHighlight.oErr, oHighlight.sKind);
        aRects.forEach((oRect, i) => {
            let xDiv = oHighlight.aDivs[i];
            xDiv.style.top = (oRect.top + window.scrollY) + "px";
            xDiv.style.left = (oRect.left + window.scrollX) + "px";
            xDiv.style.width = oRect.width + "px";
            xDiv.style.height = oRect.height + "px";
            xDiv.style.borderBottom = "solid 2px " + sColor;
        });
    },

    _ensureOverlayRoot () {
        if (!this.xOverlayRoot || !document.body.contains(this.xOverlayRoot)) {
            this.xOverlayRoot = document.createElement("div");
            this.xOverlayRoot.id = "grammalecte_inline_overlay_root";
            this.xOverlayRoot.style.position = "absolute";
            this.xOverlayRoot.style.top = "0";
            this.xOverlayRoot.style.left = "0";
            this.xOverlayRoot.style.width = "0";
            this.xOverlayRoot.style.height = "0";
            document.body.appendChild(this.xOverlayRoot);
            let bScheduled = false;
            const onScrollResize = () => {
                if (bScheduled) { return; }
                bScheduled = true;
                window.requestAnimationFrame(() => {
                    bScheduled = false;
                    this._repositionAll();
                });
            };
            window.addEventListener("scroll", onScrollResize, { passive: true, capture: true });
            window.addEventListener("resize", onScrollResize, { passive: true });
        }
        return this.xOverlayRoot;
    },

    _repositionAll () {
        for (let xNode of document.querySelectorAll("[id^='grammalecte_inline_target_']")) {
            if (this.oState.has(xNode)) {
                for (let oHighlight of this.oState.get(xNode).aHighlights) {
                    this._repositionHighlight(oHighlight);
                }
            }
        }
    },

    _clearHighlights (xNode) {
        let oData = this._getState(xNode);
        for (let oHighlight of oData.aHighlights) {
            for (let xDiv of oHighlight.aDivs) {
                xDiv.remove();
            }
        }
        oData.aHighlights = [];
        this._hideMenu();
    },

    _ensureMenu () {
        if (this.xMenu) {
            return this.xMenu;
        }
        let xMenu = document.createElement("div");
        xMenu.id = "grammalecte_inline_menu";
        Object.assign(xMenu.style, {
            position: "absolute", zIndex: "2147483647", background: "hsl(0, 0%, 100%)",
            border: "solid 1px hsl(0, 0%, 70%)", borderRadius: "4px",
            boxShadow: "0 2px 8px hsla(0, 0%, 0%, 0.3)", padding: "6px",
            font: "13px sans-serif", color: "hsl(0, 0%, 10%)", maxWidth: "320px", display: "none",
        });
        document.body.appendChild(xMenu);
        document.addEventListener("click", (xEvent) => {
            if (xEvent.target !== xMenu && !xMenu.contains(xEvent.target)) {
                this._hideMenu();
            }
        });
        this.xMenu = xMenu;
        return xMenu;
    },

    _hideMenu () {
        if (this.xMenu) {
            this.xMenu.style.display = "none";
        }
        this._oCurrentMenuHighlight = null;
        this._oCurrentMenuNode = null;
        this._xMenuSuggList = null;
    },

    _createSuggestionItem (sSugg, xRange) {
        let xItem = document.createElement("div");
        xItem.textContent = sSugg;
        Object.assign(xItem.style, { padding: "3px 6px", cursor: "pointer", borderRadius: "3px" });
        xItem.addEventListener("mouseenter", () => { xItem.style.background = "hsl(210, 60%, 92%)"; });
        xItem.addEventListener("mouseleave", () => { xItem.style.background = ""; });
        xItem.addEventListener("click", () => { this._applySuggestion(xRange, sSugg); });
        return xItem;
    },

    _showMenu (nClientX, nClientY, oHighlight) {
        let xMenu = this._ensureMenu();
        xMenu.textContent = "";
        let { xNode, oErr, sKind, xRange } = oHighlight;
        let xMessage = document.createElement("div");
        xMessage.style.marginBottom = "4px";
        xMessage.textContent = (sKind === "spelling") ? "Mot inconnu du dictionnaire." : (oErr.sMessage || "Erreur.");
        xMenu.appendChild(xMessage);

        this._xMenuSuggList = document.createElement("div");
        xMenu.appendChild(this._xMenuSuggList);

        if (sKind === "spelling") {
            this._oCurrentMenuHighlight = oHighlight;
            this._oCurrentMenuNode = xNode;
            this._xMenuSuggList.dataset.empty = "true";
            this._xMenuSuggList.textContent = "Recherche de suggestions…";
            this._xMenuSuggList.style.opacity = "0.6";
            oGrammalecteBackgroundPort.getSpellSuggestions(xRange.toString(), xNode.id, "inline");
        } else {
            this._oCurrentMenuHighlight = null;
            this._oCurrentMenuNode = null;
            let aSugg = oErr.aSuggestions || [];
            if (aSugg.length === 0) {
                this._xMenuSuggList.style.opacity = "0.6";
                this._xMenuSuggList.textContent = "Aucune suggestion.";
            } else {
                for (let sSugg of aSugg) {
                    this._xMenuSuggList.appendChild(this._createSuggestionItem(sSugg, xRange));
                }
            }
        }

        let xSep = document.createElement("div");
        xSep.style.borderTop = "solid 1px hsl(0, 0%, 85%)";
        xSep.style.margin = "4px 0";
        xMenu.appendChild(xSep);

        let xIgnore = document.createElement("div");
        xIgnore.textContent = "Ignorer";
        Object.assign(xIgnore.style, { padding: "3px 6px", cursor: "pointer", borderRadius: "3px", opacity: "0.8" });
        xIgnore.addEventListener("mouseenter", () => { xIgnore.style.background = "hsl(0, 0%, 92%)"; });
        xIgnore.addEventListener("mouseleave", () => { xIgnore.style.background = ""; });
        xIgnore.addEventListener("click", () => { this._ignoreHighlight(oHighlight); });
        xMenu.appendChild(xIgnore);

        xMenu.style.left = (nClientX + window.scrollX) + "px";
        xMenu.style.top = (nClientY + window.scrollY) + "px";
        xMenu.style.display = "block";
    },

    _applySuggestion (xRange, sSugg) {
        try {
            xRange.deleteContents();
            xRange.insertNode(document.createTextNode(sSugg));
        }
        catch (e) {
            showError(e);
        }
        this._hideMenu();
    },

    _ignoreHighlight (oHighlight) {
        if (oHighlight.sKind === "spelling") {
            let sWord = oHighlight.xRange.toString().toLowerCase();
            this.oIgnoredWords.add(sWord);
            browser.storage.local.set({ "ignored_words": Array.from(this.oIgnoredWords) });
        }
        for (let xDiv of oHighlight.aDivs) {
            xDiv.remove();
        }
        this._hideMenu();
    }
};
