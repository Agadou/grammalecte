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

/*
    Catégories de règles typographiques (voir gc_lang/fr/rules.grx, OPTLABEL/*)
    considérées comme suffisamment sûres pour une correction automatique :
    des substitutions déterministes (apostrophe courbe, espaces surnuméraires
    ou insécables, ligatures...), jamais une question de contexte/sens. Les
    catégories marquées [!] dans rules.grx (beaucoup de faux positifs, comme
    "ocr" ou "mapos") sont volontairement exclues, de même que tout ce qui
    touche à l'accord/la conjugaison/le style (jamais une certitude comparable
    à une coquille typographique).
*/
const TYPO_AUTOCORRECT_OPTIONS = new Set(["apos", "typo", "esp", "tab", "nbsp", "num", "unit", "liga"]);

/*
    En plus des catégories ci-dessus, quelques règles précises appartenant à
    des catégories plus larges (donc pas incluses entièrement) sont assez
    sûres pour être auto-corrigées : la majuscule en début de phrase (après
    un point, ou en tout début de paragraphe) est déterministe et la règle
    elle-même exclut déjà les cas ambigus (abréviations, énumérations...).
    Le reste de la catégorie "maj" (ex. "la raison d'État") n'est PAS inclus :
    risque de faux positifs sur des noms propres/communs ambigus selon le
    contexte, contrairement à une majuscule de début de phrase.
*/
const TYPO_AUTOCORRECT_RULE_IDS = new Set(["majuscule_après_point", "majuscule_début_paragraphe"]);

const oInlineChecker = {

    nNextId: 0,

    oState: new WeakMap(), // xNode -> { aCharMap, aParaStart, aPendingResults, aHighlights, nDebounceTimer }

    xMenu: null,
    oIgnoredWords: null, // Set, chargé une fois depuis browser.storage.local (clé partagée avec le panneau : "ignored_words")

    nNextAutoCorrectKey: 0,
    oAutoCorrectPending: new Map(), // clé -> { xNode, xRange, oErr, aSugg, nTimer }

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
                if (oData.oInfo && oData.oInfo.sErrorId && oData.oInfo.sErrorId.startsWith("autocorrect:")) {
                    this._onAutoCorrectSugg(oData.oInfo.sErrorId.slice(12), oData.oResult);
                } else {
                    this._onSpellSugg(xNode, oData.oResult);
                }
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
                if (this._tryTypoAutoCorrect(xNode, nBase + oErr.nStart, nBase + oErr.nEnd, oErr)) {
                    // le texte a changé : les décalages du reste de cette passe ne sont
                    // plus fiables, on arrête là — une analyse fraîche a été programmée.
                    return;
                }
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

    // Corrections typographiques déterministes (voir TYPO_AUTOCORRECT_OPTIONS) :
    // contrairement à l'orthographe, la suggestion est déjà fournie avec l'erreur,
    // pas besoin d'aller la chercher. Retourne true si la correction a été appliquée.
    _tryTypoAutoCorrect (xNode, nStart, nEnd, oErr) {
        let bAllowed = TYPO_AUTOCORRECT_OPTIONS.has(oErr.sType) || TYPO_AUTOCORRECT_RULE_IDS.has(oErr.sRuleId);
        if (!bAllowed || !oErr.aSuggestions || oErr.aSuggestions.length !== 1) {
            return false;
        }
        let xRange = this._buildRange(xNode, nStart, nEnd);
        if (!xRange) {
            return false;
        }
        this._applyAutoCorrection(xNode, xRange, nStart, nEnd, oErr.aSuggestions[0]);
        return true;
    },

    // Remplace le texte de <xRange> (couvrant [nStart, nEnd[ dans le texte aplati
    // courant de <xNode>) par <sNewText>, en conservant la position du curseur s'il
    // s'y trouvait, puis reprogramme une analyse fraîche (les décalages ont changé).
    _applyAutoCorrection (xNode, xRange, nStart, nEnd, sNewText) {
        let oState = this._getState(xNode);
        let nOldCaret = this._getGlobalCaretOffset(xNode, oState.aCharMap);
        let bWasFocused = (document.activeElement === xNode) || xNode.contains(this._getSelectionNode());
        try {
            xRange.deleteContents();
            xRange.insertNode(document.createTextNode(sNewText));
        }
        catch (e) {
            showError(e);
            return;
        }
        let { aCharMap, aParaStart } = this._extractTextAndMap(xNode);
        oState.aCharMap = aCharMap;
        oState.aParaStart = aParaStart;
        if (bWasFocused && nOldCaret >= 0) {
            let nDelta = sNewText.length - (nEnd - nStart);
            let nNewCaret;
            if (nOldCaret >= nEnd) {
                nNewCaret = nOldCaret + nDelta;
            } else if (nOldCaret >= nStart) {
                nNewCaret = nStart + sNewText.length;
            } else {
                nNewCaret = nOldCaret;
            }
            this._setGlobalCaretOffset(xNode, aCharMap, nNewCaret);
        }
        this.scheduleCheck(xNode);
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
        let oHighlight = { xNode, xRange, nStart, nEnd, oErr, sKind, aDivs: [] };
        this._getState(xNode).aHighlights.push(oHighlight);
        this._repositionHighlight(oHighlight);
        if (sKind === "spelling") {
            this._checkAutoCorrect(oHighlight);
        }
    },

    /*
        Auto-correction : uniquement pour les mots inconnus du dictionnaire dont
        LA SEULE proposition qui ne diffère du mot tapé que par des accents
        (ex. "cinema" -> "cinéma", "epouvantail" -> "épouvantail"). C'est le seul
        cas où l'orthographe correcte est certaine sans ambiguïté — si plusieurs
        graphies accentuées différentes sont possibles (ex. plusieurs mots
        existent selon les accents), ou si la correction change autre chose que
        des accents, on ne touche à rien et on laisse le soulignage + le clic
        droit habituels. Les erreurs de grammaire ne sont jamais auto-corrigées :
        ce sont des suggestions contextuelles, jamais une certitude comparable.
    */
    _stripAccents (s) {
        return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    },

    _checkAutoCorrect (oHighlight) {
        let { xNode, oErr } = oHighlight;
        if (!xNode.id) {
            return;
        }
        let sKey = "" + (this.nNextAutoCorrectKey++);
        let oPending = { xNode, oHighlight, sWord: oErr.sValue, aSugg: [], nTimer: null };
        this.oAutoCorrectPending.set(sKey, oPending);
        oPending.nTimer = window.setTimeout(() => { this._finishAutoCorrect(sKey); }, 300);
        oGrammalecteBackgroundPort.getSpellSuggestions(oErr.sValue, xNode.id, "autocorrect:" + sKey);
    },

    _onAutoCorrectSugg (sKey, oResult) {
        let oPending = this.oAutoCorrectPending.get(sKey);
        if (!oPending || oResult.sWord.toLowerCase() !== oPending.sWord.toLowerCase()) {
            return;
        }
        oPending.aSugg.push(...oResult.aSugg);
    },

    _finishAutoCorrect (sKey) {
        let oPending = this.oAutoCorrectPending.get(sKey);
        if (!oPending) {
            return;
        }
        this.oAutoCorrectPending.delete(sKey);
        let { oHighlight, sWord, aSugg } = oPending;
        // le surlignage a pu disparaître entre-temps (mot ignoré, texte modifié...)
        if (!this._getState(oHighlight.xNode).aHighlights.includes(oHighlight)) {
            return;
        }
        let sStripped = this._stripAccents(sWord).toLowerCase();
        let aCandidates = [...new Set(aSugg)].filter((s) =>
            s.toLowerCase() !== sWord.toLowerCase() && this._stripAccents(s).toLowerCase() === sStripped
        );
        if (aCandidates.length !== 1) {
            return; // pas de certitude : on laisse le soulignage normal, l'utilisateur choisit
        }
        let xNode = oHighlight.xNode;
        for (let xDiv of oHighlight.aDivs) {
            xDiv.remove();
        }
        let oState = this._getState(xNode);
        oState.aHighlights = oState.aHighlights.filter((h) => h !== oHighlight);
        this._applyAutoCorrection(xNode, oHighlight.xRange, oHighlight.nStart, oHighlight.nEnd, aCandidates[0]);
    },

    _getSelectionNode () {
        let xSel = window.getSelection();
        return (xSel && xSel.rangeCount > 0) ? xSel.getRangeAt(0).startContainer : null;
    },

    _getGlobalCaretOffset (xNode, aCharMap) {
        let xSel = window.getSelection();
        if (!xSel || xSel.rangeCount === 0 || !xSel.isCollapsed) {
            return -1;
        }
        let xRange = xSel.getRangeAt(0);
        if (!xNode.contains(xRange.startContainer)) {
            return -1;
        }
        for (let i = 0; i < aCharMap.length; i++) {
            let o = aCharMap[i];
            if (o && o.xTextNode === xRange.startContainer && o.iOffset === xRange.startOffset) {
                return i;
            }
        }
        // curseur juste après le dernier caractère d'un nœud texte
        if (xRange.startContainer.nodeType === Node.TEXT_NODE && xRange.startOffset === xRange.startContainer.textContent.length) {
            for (let i = aCharMap.length - 1; i >= 0; i--) {
                if (aCharMap[i] && aCharMap[i].xTextNode === xRange.startContainer) {
                    return i + 1;
                }
            }
        }
        return -1;
    },

    _setGlobalCaretOffset (xNode, aCharMap, nOffset) {
        if (nOffset < 0) {
            return;
        }
        let oTarget = null;
        if (nOffset < aCharMap.length && aCharMap[nOffset]) {
            oTarget = { xTextNode: aCharMap[nOffset].xTextNode, iOffset: aCharMap[nOffset].iOffset };
        } else if (nOffset > 0 && aCharMap[nOffset - 1]) {
            oTarget = { xTextNode: aCharMap[nOffset - 1].xTextNode, iOffset: aCharMap[nOffset - 1].iOffset + 1 };
        }
        if (!oTarget) {
            return;
        }
        try {
            let xRange = document.createRange();
            xRange.setStart(oTarget.xTextNode, oTarget.iOffset);
            xRange.collapse(true);
            let xSel = window.getSelection();
            xSel.removeAllRanges();
            xSel.addRange(xRange);
        }
        catch (e) {
            showError(e);
        }
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
