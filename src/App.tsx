/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import Papa from 'papaparse';
import { Upload, FileText, Search, ZoomIn, ZoomOut, ChevronLeft, ChevronRight, ChevronDown, Info, AlertCircle, Sun, Moon, Bug, X } from 'lucide-react';
import { cn } from './lib/utils';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

interface BOMEntry {
  "Part Reference": string;
  "Part Number"?: string;
  "Component_Name"?: string;
  "Optional"?: string;
  description?: string;
  quantity?: string;
  originalLine?: string;
  lineNumber?: number;
  [key: string]: any;
}

interface MatchResult {
  pageNumber: number;
  viewport: pdfjsLib.PageViewport;
  transform: number[];
  width: number;
  height: number;
  text: string;
}

const sortBOMData = (data: BOMEntry[]) => {
  return [...data].sort((a, b) => {
    const refA = a["Part Reference"] || "";
    const refB = b["Part Reference"] || "";

    // Extract page number (first two digits after letters, allowing optional spaces/underscores)
    const matchA = refA.match(/^[A-Za-z]+[\s_]*(\d{2})/);
    const matchB = refB.match(/^[A-Za-z]+[\s_]*(\d{2})/);

    const pageA = matchA ? parseInt(matchA[1], 10) : 9999;
    const pageB = matchB ? parseInt(matchB[1], 10) : 9999;

    if (pageA !== pageB) {
      return pageA - pageB;
    }

    // Fallback to standard alphanumeric sort
    return refA.localeCompare(refB, undefined, { numeric: true, sensitivity: 'base' });
  });
};

export default function App() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [bomData, setBomData] = useState<BOMEntry[]>([]);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfPageTexts, setPdfPageTexts] = useState<string[][]>([]);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInputValue, setPageInputValue] = useState("1");
  const [scale, setScale] = useState(1.5);
  const [selectedDesignator, setSelectedDesignator] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [showDebugModal, setShowDebugModal] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const groupedBomData = useMemo(() => {
    const groups: Record<number, BOMEntry[]> = {};
    const unknownGroup: BOMEntry[] = [];

    bomData.forEach(entry => {
      const ref = entry["Part Reference"] || "";
      const match = ref.match(/^[A-Za-z]+[\s_]*(\d{2})/);
      const page = match ? parseInt(match[1], 10) : null;

      if (page !== null) {
        if (!groups[page]) groups[page] = [];
        groups[page].push(entry);
      } else {
        unknownGroup.push(entry);
      }
    });

    const sortedGroups = Object.keys(groups)
      .map(Number)
      .sort((a, b) => a - b)
      .map(page => ({ page, entries: groups[page] }));

    if (unknownGroup.length > 0) {
      sortedGroups.push({ page: 9999, entries: unknownGroup });
    }

    return sortedGroups;
  }, [bomData]);

  // Handle PDF Upload
  const handlePdfUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      setPdfFile(file);
      setError(null);
      setSelectedDesignator(null);
      setSelectedGroup(null);
      loadPdf(file);
    } else {
      setError('Please upload a valid PDF file.');
    }
  };

  useEffect(() => {
    setPageInputValue(currentPage.toString());
  }, [currentPage]);

  const handlePageInputSubmit = () => {
    const pageNum = parseInt(pageInputValue, 10);
    if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= numPages) {
      setCurrentPage(pageNum);
    } else {
      setPageInputValue(currentPage.toString());
    }
  };

  // Handle BOM Upload
  const handleBomUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedDesignator(null);
      setSelectedGroup(null);
      const isTextFile = file.name.endsWith('.txt') || file.type === 'text/plain';
      
      if (isTextFile) {
        const reader = new FileReader();
        reader.onload = (event) => {
          let text = event.target?.result as string;
          // Strip BOM if present
          if (text.charCodeAt(0) === 0xFEFF) {
            text = text.substring(1);
          }
          const lines = text.split(/\r?\n/).filter(line => line.trim());
          
          if (lines.length === 0) return;

          // Check if the first line looks like a header
          const firstLine = lines[0];
          const isTabSeparated = firstLine.includes('\t');
          const isCommaSeparated = firstLine.includes(',');
          const delimiter = isTabSeparated ? '\t' : (isCommaSeparated ? ',' : /\s{2,}/);
          
          // Split all lines into a grid
          const grid = lines.map(line => line.split(delimiter).map(p => p.trim()));
          
          let refIdx = -1;
          let pnIdx = -1;
          let nameIdx = -1;
          let optIdx = -1;

          // Check if we have a valid grid
          if (grid.length > 0) {
            const numCols = Math.max(...grid.map(row => row.length));
            
            // If it's just 1 column, the delimiter is probably wrong, or it's unstructured
            if (numCols > 1) {
              // Analyze each column to guess its type
              for (let col = 0; col < numCols; col++) {
                let refScore = 0;
                let pnScore = 0;
                let nameScore = 0;
                let optScore = 0;
                
                let validRows = 0;
                
                // Check up to 10 rows to determine column type
                for (let row = 0; row < Math.min(grid.length, 10); row++) {
                  const cell = grid[row][col];
                  if (!cell) continue;
                  
                  // If it's the first row, check if it matches known headers
                  if (row === 0) {
                    if (/Part[\s_]*Referenc|^Reference$|^RefDes$|^Designator$|^Ref$|^Location$|^Part$/i.test(cell)) refScore += 10;
                    if (/Part[\s_]*Number|^P\/?N$|^PN$|^Material$|^Item$/i.test(cell)) pnScore += 10;
                    if (/Component[\s_]*Name|^Name$|^Component$|^Value$|^Part[\s_]*Type$/i.test(cell)) nameScore += 10;
                    if (/Optional|^Opt$|^DNP$/i.test(cell)) optScore += 10;
                  }
                  
                  validRows++;
                  
                  // Data heuristics
                  if (/^[A-Z]{1,3}\d+[A-Z]?$/i.test(cell)) {
                    refScore++;
                  } else if (/^[A-Z0-9-]{6,}$/i.test(cell) && !/\s/.test(cell) && !/OHM|FARAD|VOLT|WATT/i.test(cell)) {
                    pnScore++;
                  } else if (/\s/.test(cell) || /OHM|FARAD|VOLT|WATT|RES|CAP|IND|MLCC/i.test(cell)) {
                    nameScore++;
                  } else if (/^(N\/A|@|DNP|NO\s*STUFF|OPTIONAL)$/i.test(cell)) {
                    optScore++;
                  }
                }
                
                // Assign column based on highest score
                if (validRows > 0) {
                  const maxScore = Math.max(refScore, pnScore, nameScore, optScore);
                  if (maxScore > 0) { // Only assign if there's some evidence
                    if (maxScore === refScore && refIdx === -1) refIdx = col;
                    else if (maxScore === pnScore && pnIdx === -1) pnIdx = col;
                    else if (maxScore === nameScore && nameIdx === -1) nameIdx = col;
                    else if (maxScore === optScore && optIdx === -1) optIdx = col;
                  }
                }
              }
            }
          }
          
          const processedData: BOMEntry[] = [];

          if (refIdx !== -1 || pnIdx !== -1) {
            // Structured parsing
            // Check if the first row is a header row (if it doesn't match data heuristics)
            let startRow = 0;
            if (grid.length > 0) {
              const firstRowRef = refIdx !== -1 ? grid[0][refIdx] : '';
              const firstRowPn = pnIdx !== -1 ? grid[0][pnIdx] : '';
              // If the first row's Ref doesn't look like a Ref, or PN doesn't look like a PN, it's probably a header
              if ((firstRowRef && !/^[A-Z]{1,3}\d+[A-Z]?$/i.test(firstRowRef)) || 
                  (firstRowPn && !/^[A-Z0-9-]{6,}$/i.test(firstRowPn))) {
                startRow = 1;
              }
            }

            for (let i = startRow; i < grid.length; i++) {
              const parts = grid[i];
              if (parts.length === 0 || (parts.length === 1 && !parts[0])) continue;

              const designator = refIdx !== -1 ? parts[refIdx] : '';
              const partNumber = pnIdx !== -1 ? parts[pnIdx] : '';
              
              if (!designator && !partNumber) continue;

              const entry: BOMEntry = {
                "Part Reference": (designator || '').toUpperCase(),
                "Part Number": partNumber || '',
                "Component_Name": nameIdx !== -1 ? parts[nameIdx] : '',
                "Optional": optIdx !== -1 ? parts[optIdx] : '',
                description: parts.join(' '),
                originalLine: lines[i],
                lineNumber: i + 1
              };

              processedData.push(entry);
            }
          } else {
            // Fallback to regex-based parsing for unstructured text
            const designatorRegex = /^[A-Z]{1,3}\d+[A-Z]?$/i;
            const pnRegex = /^[A-Z0-9-]{6,}$/i;
            
            lines.forEach((line, index) => {
              const parts = line.trim().split(/[\s,\t]+/);
              let foundDesignator = '';
              let foundPN = '';
              let foundName: string[] = [];
              
              for (const part of parts) {
                if (!foundDesignator && designatorRegex.test(part) && !/OHM|FARAD|VOLT|WATT/i.test(part)) {
                  foundDesignator = part.toUpperCase();
                } else if (!foundPN && pnRegex.test(part) && !/OHM|FARAD|VOLT|WATT/i.test(part)) {
                  foundPN = part;
                } else {
                  foundName.push(part);
                }
              }
              
              if (foundDesignator || foundPN) {
                processedData.push({
                  "Part Reference": foundDesignator,
                  "Part Number": foundPN,
                  "Component_Name": foundName.join(' '),
                  description: line.trim(),
                  originalLine: line.trim(),
                  lineNumber: index + 1
                });
              }
            });
          }
          
          console.log("Parsed Text BOM Data:", processedData);
          setBomData(sortBOMData(processedData));
        };
        reader.readAsText(file);
      } else {
        // Handle CSV
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            const data = results.data as any[];
            const processedData = data.map(row => {
              const designatorKey = Object.keys(row).find(k => 
                /Part[\s_]*Reference|^designator$|^ref$|^reference$|^refdes$|^location$|^part$/i.test(k.trim())
              );
              const pnKey = Object.keys(row).find(k => 
                /Part[\s_]*Number|^pn$|^p\/n$|^material$|^item$/i.test(k.trim())
              );
              const nameKey = Object.keys(row).find(k => 
                /Component[\s_]*Name|^name$|^desc|^value$|^part[\s_]*type$/i.test(k.trim())
              );
              const optKey = Object.keys(row).find(k => 
                /Optional|^opt$|^dnp$/i.test(k.trim())
              );
              
              const newRow: any = { ...row };
              
              newRow["Part Reference"] = String(designatorKey ? row[designatorKey] : Object.values(row)[0]).trim().toUpperCase();
              newRow["Part Number"] = pnKey ? row[pnKey] : '';
              newRow["Component_Name"] = nameKey ? row[nameKey] : '';
              newRow["Optional"] = optKey ? row[optKey] : '';
              
              if (designatorKey && designatorKey !== "Part Reference") delete newRow[designatorKey];
              if (pnKey && pnKey !== "Part Number") delete newRow[pnKey];
              if (nameKey && nameKey !== "Component_Name") delete newRow[nameKey];
              if (optKey && optKey !== "Optional") delete newRow[optKey];
              
              return newRow as BOMEntry;
            });
            const finalData = processedData.filter(d => d["Part Reference"]);
            console.log("Parsed CSV BOM Data:", finalData);
            setBomData(sortBOMData(finalData));
          },
          error: (err) => {
            setError('Failed to parse BOM file.');
            console.error(err);
          }
        });
      }
    }
  };

  const loadPdf = async (file: File) => {
    setIsLoading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const doc = await loadingTask.promise;
      setPdfDoc(doc);
      setNumPages(doc.numPages);
      setCurrentPage(1);
      setPageInputValue("1");

      // Extract text for all pages for fast searching
      const pageTexts: string[][] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const textContent = await page.getTextContent();
        pageTexts.push(textContent.items.map((item: any) => item.str));
      }
      setPdfPageTexts(pageTexts);
    } catch (err) {
      setError('Error loading PDF.');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  // Render PDF Page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    let renderTask: any = null;
    let isCancelled = false;

    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(currentPage);
        if (isCancelled) return;

        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current!;
        const context = canvas.getContext('2d')!;

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        };

        renderTask = page.render(renderContext);
        await renderTask.promise;

        if (isCancelled) return;

        // After rendering, if we have a selected designator or group, highlight it
        if (selectedDesignator) {
          searchAndHighlight(page, viewport, [selectedDesignator]);
        } else if (selectedGroup !== null) {
          const group = groupedBomData.find(g => g.page === selectedGroup);
          if (group) {
            const terms = group.entries.map(e => e["Part Reference"]);
            searchAndHighlight(page, viewport, terms);
          }
        }
      } catch (error: any) {
        if (error.name === 'RenderingCancelledException') {
          // Ignore cancelled renders
        } else {
          console.error("Error rendering page:", error);
        }
      }
    };

    renderPage();

    return () => {
      isCancelled = true;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [pdfDoc, currentPage, scale, selectedDesignator, selectedGroup, groupedBomData, isLoading]);

  useEffect(() => {
    if (selectedGroup !== null && selectedGroup !== 9999) {
      setCurrentPage(prev => (prev !== selectedGroup && selectedGroup <= numPages) ? selectedGroup : prev);
    } else if (selectedDesignator && pdfPageTexts.length > 0) {
      const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Allow optional letter suffix (e.g., Q0301 matching Q0301A, Q0301B, etc.)
      const regex = new RegExp(`\\b${escapeRegExp(selectedDesignator)}[A-Za-z]*\\b`, 'i');
      
      const pageIndex = pdfPageTexts.findIndex(pageItems => 
        pageItems.some(str => regex.test(str) || str === selectedDesignator)
      );
      
      if (pageIndex !== -1) {
        const targetPage = pageIndex + 1;
        setCurrentPage(prev => prev !== targetPage ? targetPage : prev);
      }
    }
  }, [selectedDesignator, selectedGroup, pdfPageTexts, numPages]);

  // Auto-zoom when selecting a component
  useEffect(() => {
    if (selectedDesignator) {
      setScale(prev => Math.max(prev, 2.5));
    }
  }, [selectedDesignator]);

  // Auto-scroll to selected component
  useEffect(() => {
    if (selectedDesignator && matches.length > 0 && containerRef.current) {
      const match = matches.find(m => {
        const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapeRegExp(selectedDesignator)}[A-Za-z]*\\b`, 'i');
        return regex.test(m.text) || m.text === selectedDesignator;
      });

      if (match) {
        // Calculate coordinates on the canvas
        const tx = pdfjsLib.Util.transform(
          pdfjsLib.Util.transform(match.viewport.transform, match.transform),
          [1, 0, 0, -1, 0, 0]
        );

        const currentScale = match.viewport.scale;
        const x = tx[4];
        const y = tx[5] - match.height * currentScale;

        // Center the match in the container
        const container = containerRef.current;
        const scrollX = x - container.clientWidth / 2 + (match.width * currentScale) / 2;
        const scrollY = y - container.clientHeight / 2 + (match.height * currentScale) / 2;

        container.scrollTo({
          left: Math.max(0, scrollX),
          top: Math.max(0, scrollY),
          behavior: 'smooth'
        });
      }
    }
  }, [selectedDesignator, matches]);

  const searchAndHighlight = async (page: pdfjsLib.PDFPageProxy, viewport: pdfjsLib.PageViewport, searchTerms: string[]) => {
    const textContent = await page.getTextContent();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const foundMatches: MatchResult[] = [];
    
    const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Allow optional letter suffix (e.g., Q0301 matching Q0301A, Q0301B, etc.)
    const regexes = searchTerms.map(term => new RegExp(`\\b${escapeRegExp(term)}[A-Za-z]*\\b`, 'i'));

    textContent.items.forEach((item: any) => {
      if ('str' in item) {
        const match = regexes.some((regex, idx) => regex.test(item.str) || item.str === searchTerms[idx]);
        if (match) {
          const tx = pdfjsLib.Util.transform(
            pdfjsLib.Util.transform(viewport.transform, item.transform),
            [1, 0, 0, -1, 0, 0]
          );

          // Draw highlight
          ctx.strokeStyle = 'red';
          ctx.lineWidth = 2;
          ctx.strokeRect(tx[4], tx[5] - item.height * scale, item.width * scale, item.height * scale);
          
          foundMatches.push({
            pageNumber: currentPage,
            viewport,
            transform: item.transform,
            width: item.width,
            height: item.height,
            text: item.str
          });
        }
      }
    });

    setMatches(foundMatches);
  };

  const selectedBomEntry = useMemo(() => {
    return bomData.find(entry => entry["Part Reference"] === selectedDesignator);
  }, [bomData, selectedDesignator]);

  return (
    <div className={cn(
      "h-screen flex flex-col font-sans transition-colors duration-300 overflow-hidden",
      isDarkMode ? "bg-neutral-900 text-neutral-100 dark" : "bg-neutral-100 text-neutral-900"
    )}>
      {/* Header */}
      <header className={cn(
        "border-b px-6 py-4 flex items-center justify-between shadow-sm z-20 transition-colors",
        isDarkMode ? "bg-neutral-800 border-neutral-700" : "bg-white border-neutral-200"
      )}>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="bg-red-600 p-2 rounded-lg">
              <Search className="text-white w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Circuit Inspector</h1>
          </div>
          
          {/* Search Input */}
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className={cn("h-4 w-4", isDarkMode ? "text-neutral-400" : "text-neutral-500")} />
            </div>
            <input
              type="text"
              placeholder="Search designator (e.g. R123)"
              value={selectedDesignator || ""}
              onChange={(e) => setSelectedDesignator(e.target.value.toUpperCase() || null)}
              className={cn(
                "pl-10 pr-4 py-1.5 rounded-md border text-sm w-64 focus:outline-none focus:ring-2 focus:ring-red-500 transition-colors",
                isDarkMode 
                  ? "bg-neutral-900 border-neutral-700 text-neutral-100 placeholder-neutral-500" 
                  : "bg-neutral-100 border-neutral-300 text-neutral-900 placeholder-neutral-500"
              )}
            />
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)}
            className={cn(
              "p-2 rounded-full transition-colors",
              isDarkMode ? "bg-neutral-700 text-yellow-400 hover:bg-neutral-600" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
            )}
            title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
          >
            {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>

          <label className={cn(
            "flex items-center gap-2 cursor-pointer border px-3 py-1.5 rounded-md transition-colors text-sm font-medium",
            isDarkMode ? "bg-neutral-700 border-neutral-600 hover:bg-neutral-600 text-neutral-200" : "bg-white border-neutral-300 hover:bg-neutral-50 text-neutral-700"
          )}>
            <Upload className="w-4 h-4" />
            Upload PDF
            <input type="file" accept=".pdf" className="hidden" onChange={handlePdfUpload} />
          </label>
          <label className={cn(
            "flex items-center gap-2 cursor-pointer border px-3 py-1.5 rounded-md transition-colors text-sm font-medium",
            isDarkMode ? "bg-neutral-700 border-neutral-600 hover:bg-neutral-600 text-neutral-200" : "bg-white border-neutral-300 hover:bg-neutral-50 text-neutral-700"
          )}>
            <FileText className="w-4 h-4" />
            Upload BOM (CSV/TXT)
            <input type="file" accept=".csv,.txt" className="hidden" onChange={handleBomUpload} />
          </label>
          
          <button 
            onClick={() => setShowDebugModal(true)}
            className={cn(
              "flex items-center gap-2 border px-3 py-1.5 rounded-md transition-colors text-sm font-medium",
              isDarkMode ? "bg-neutral-700 border-neutral-600 hover:bg-neutral-600 text-neutral-200" : "bg-white border-neutral-300 hover:bg-neutral-50 text-neutral-700"
            )}
            title="Debug BOM Data"
          >
            <Bug className="w-4 h-4 text-emerald-500" />
            Debug BOM
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Left Sidebar - BOM Components */}
        <div className={cn(
          "w-80 flex flex-col border-r transition-colors shrink-0",
          isDarkMode ? "bg-neutral-900 border-neutral-800" : "bg-white border-neutral-200"
        )}>
          <div className={cn(
            "p-4 border-b flex items-center justify-between",
            isDarkMode ? "border-neutral-800 bg-neutral-800/50" : "border-neutral-200 bg-neutral-50"
          )}>
            <h2 className={cn(
              "font-semibold flex items-center gap-2",
              isDarkMode ? "text-neutral-200" : "text-neutral-800"
            )}>
              <FileText className="w-4 h-4" />
              COMPONENTS
            </h2>
            <span className={cn(
              "text-xs px-2 py-0.5 rounded-full font-medium",
              isDarkMode ? "bg-neutral-800 text-neutral-300" : "bg-neutral-200 text-neutral-700"
            )}>
              {bomData.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {bomData.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-neutral-400 py-12 text-center">
                <FileText className="w-12 h-12 mb-4 opacity-20" />
                <p className="text-sm">No components loaded.</p>
                <p className="text-xs mt-1 opacity-70">Upload a BOM file to see the list here.</p>
              </div>
            ) : (
              groupedBomData.map((group) => {
                const isGroupSelected = selectedGroup === group.page;
                const isExpanded = expandedGroups.has(group.page);
                
                return (
                  <div key={group.page} className="mb-3">
                    <div 
                      onClick={() => {
                        setExpandedGroups(prev => {
                          const next = new Set(prev);
                          if (next.has(group.page)) next.delete(group.page);
                          else next.add(group.page);
                          return next;
                        });
                        setSelectedGroup(group.page);
                        setSelectedDesignator(null);
                      }}
                      className={cn(
                        "flex items-center justify-between p-2 rounded-md cursor-pointer transition-colors border",
                        isGroupSelected 
                          ? (isDarkMode ? "bg-red-900/30 border-red-800 text-red-400" : "bg-red-100 border-red-300 text-red-700")
                          : (isDarkMode ? "bg-neutral-800 border-neutral-700 hover:bg-neutral-700" : "bg-neutral-100 border-neutral-200 hover:bg-neutral-200")
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <ChevronDown className={cn("w-4 h-4 transition-transform", isExpanded ? "" : "-rotate-90")} />
                        <span className="font-bold text-sm">
                          {group.page === 9999 ? "Other Components" : `Page ${group.page}`}
                        </span>
                      </div>
                      <span className="text-xs opacity-70 font-mono bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded">
                        {group.entries.length}
                      </span>
                    </div>
                    
                    {isExpanded && (
                      <div className="mt-2 pl-2 space-y-2 border-l-2 border-neutral-200 dark:border-neutral-800 ml-3">
                        {group.entries.map((item, idx) => {
                          const isSelected = selectedDesignator === item["Part Reference"];
                          return (
                            <div 
                              key={idx} 
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedDesignator(item["Part Reference"]);
                                setSelectedGroup(null);
                              }}
                              className={cn(
                                "p-3 rounded-md border text-sm cursor-pointer transition-all hover:shadow-sm",
                                isSelected 
                                  ? (isDarkMode ? "bg-red-900/20 border-red-800 shadow-inner" : "bg-red-50 border-red-200 shadow-inner")
                                  : (isDarkMode ? "bg-neutral-800/50 border-neutral-800 hover:bg-neutral-700" : "bg-white border-neutral-200 hover:border-neutral-300")
                              )}
                            >
                              <div className="flex justify-between items-start mb-2">
                                <span className={cn(
                                  "font-bold",
                                  isSelected ? "text-red-500" : (isDarkMode ? "text-neutral-200" : "text-neutral-800")
                                )}>
                                  {item["Part Reference"]}
                                </span>
                                {item["Optional"] && (
                                  <span className={cn(
                                    "text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wider",
                                    isDarkMode ? "bg-amber-900/30 text-amber-400" : "bg-amber-100 text-amber-700"
                                  )}>
                                    {item["Optional"]}
                                  </span>
                                )}
                              </div>
                              <div className="grid grid-cols-1 gap-1 text-xs">
                                <div className="flex justify-between items-center gap-2">
                                  <span className={cn("shrink-0", isDarkMode ? "text-neutral-500" : "text-neutral-400")}>PN:</span>
                                  <span className={cn("font-mono truncate", isDarkMode ? "text-neutral-300" : "text-neutral-600")}>
                                    {item["Part Number"] || '-'}
                                  </span>
                                </div>
                                <div className="flex justify-between items-center gap-2">
                                  <span className={cn("shrink-0", isDarkMode ? "text-neutral-500" : "text-neutral-400")}>Name:</span>
                                  <span className={cn("truncate", isDarkMode ? "text-neutral-300" : "text-neutral-600")} title={item["Component_Name"]}>
                                    {item["Component_Name"] || '-'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* PDF Viewer Area */}
        <div className={cn(
          "flex-1 flex flex-col relative overflow-hidden transition-colors",
          isDarkMode ? "bg-neutral-900" : "bg-neutral-200"
        )}>
          {/* Toolbar */}
          <div className={cn(
            "backdrop-blur-md border-b p-2 flex items-center justify-between z-10 transition-colors",
            isDarkMode ? "bg-neutral-800/80 border-neutral-700 text-neutral-200" : "bg-white/80 border-neutral-200 text-neutral-800"
          )}>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage <= 1}
                className={cn(
                  "p-1.5 rounded disabled:opacity-30 transition-colors",
                  isDarkMode ? "hover:bg-neutral-700" : "hover:bg-neutral-200"
                )}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-1 text-sm font-medium px-2">
                <span>Page</span>
                <input
                  type="number"
                  min={1}
                  max={numPages || 1}
                  value={pageInputValue}
                  onChange={(e) => setPageInputValue(e.target.value)}
                  onBlur={handlePageInputSubmit}
                  onKeyDown={(e) => e.key === 'Enter' && handlePageInputSubmit()}
                  className={cn(
                    "w-12 text-center rounded border py-0.5 outline-none transition-colors",
                    isDarkMode 
                      ? "bg-neutral-900 border-neutral-700 focus:border-red-500 text-neutral-200" 
                      : "bg-white border-neutral-300 focus:border-red-500 text-neutral-800"
                  )}
                />
                <span>of {numPages || '?'}</span>
              </div>
              <button 
                onClick={() => setCurrentPage(prev => Math.min(numPages, prev + 1))}
                disabled={currentPage >= numPages}
                className={cn(
                  "p-1.5 rounded disabled:opacity-30 transition-colors",
                  isDarkMode ? "hover:bg-neutral-700" : "hover:bg-neutral-200"
                )}
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button 
                onClick={() => setScale(s => Math.max(0.5, s - 0.25))} 
                className={cn(
                  "p-1.5 rounded transition-colors",
                  isDarkMode ? "hover:bg-neutral-700" : "hover:bg-neutral-200"
                )}
              >
                <ZoomOut className="w-5 h-5" />
              </button>
              <span className="text-sm font-medium w-12 text-center">{Math.round(scale * 100)}%</span>
              <button 
                onClick={() => setScale(s => Math.min(5, s + 0.25))} 
                className={cn(
                  "p-1.5 rounded transition-colors",
                  isDarkMode ? "hover:bg-neutral-700" : "hover:bg-neutral-200"
                )}
              >
                <ZoomIn className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Canvas Container */}
          <div 
            className="flex-1 overflow-auto p-8 text-center" 
            ref={containerRef}
          >
            {isLoading ? (
              <div className="inline-flex flex-col items-center justify-center h-full text-neutral-500">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600 mb-4"></div>
                <p>Loading schematic...</p>
              </div>
            ) : pdfDoc ? (
              <div className={cn(
                "inline-block relative shadow-2xl transition-all duration-500 text-left align-middle",
                isDarkMode ? "bg-neutral-800 ring-1 ring-neutral-700" : "bg-white"
              )}>
                <canvas ref={canvasRef} className="block" />
              </div>
            ) : (
              <div className="inline-flex flex-col items-center justify-center h-full text-neutral-400 max-w-md text-center">
                <Search className="w-16 h-16 mb-4 opacity-10" />
                <h3 className={cn(
                  "text-lg font-semibold mb-2",
                  isDarkMode ? "text-neutral-500" : "text-neutral-600"
                )}>No Schematic Loaded</h3>
                <p className="text-sm">Upload a circuit diagram PDF to start inspecting your components.</p>
              </div>
            )}
          </div>

          {/* Info Panel Overlay */}
          {selectedDesignator && (
            <div className={cn(
              "absolute bottom-6 right-6 w-80 shadow-2xl rounded-xl border overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300 z-30 transition-colors",
              isDarkMode ? "bg-neutral-800 border-neutral-700" : "bg-white border-neutral-200"
            )}>
              <div className="bg-red-600 p-4 text-white flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Info className="w-5 h-5" />
                  <span className="font-bold tracking-tight">{selectedDesignator}</span>
                </div>
                <button onClick={() => setSelectedDesignator(null)} className="hover:bg-red-700 p-1 rounded">
                  <ChevronRight className="w-4 h-4 rotate-90" />
                </button>
              </div>
              <div className="p-4 space-y-3">
                {selectedBomEntry ? (
                  <>
                    {selectedBomEntry.originalLine && (
                      <div className="space-y-1">
                        <label className={cn(
                          "text-[10px] uppercase font-bold tracking-wider",
                          isDarkMode ? "text-neutral-500" : "text-neutral-400"
                        )}>Source Line (L{selectedBomEntry.lineNumber})</label>
                        <p className={cn(
                          "text-xs font-mono break-words p-2 rounded",
                          isDarkMode ? "bg-neutral-900 text-neutral-300" : "bg-neutral-50 text-neutral-600"
                        )}>{selectedBomEntry.originalLine}</p>
                      </div>
                    )}
                    {Object.entries(selectedBomEntry).map(([key, value]) => (
                      !['Part Reference', 'originalLine', 'lineNumber'].includes(key) && value && (
                        <div key={key} className="space-y-1">
                          <label className={cn(
                            "text-[10px] uppercase font-bold tracking-wider",
                            isDarkMode ? "text-neutral-500" : "text-neutral-400"
                          )}>{key}</label>
                          <p className={cn(
                            "text-sm break-words",
                            isDarkMode ? "text-neutral-200" : "text-neutral-800"
                          )}>{String(value)}</p>
                        </div>
                      )
                    ))}
                  </>
                ) : (
                  <div className={cn(
                    "flex items-center gap-2 p-3 rounded-lg",
                    isDarkMode ? "text-amber-400 bg-amber-900/20" : "text-amber-600 bg-amber-50"
                  )}>
                    <AlertCircle className="w-4 h-4" />
                    <p className="text-xs font-medium">Component not found in BOM data.</p>
                  </div>
                )}
                
                <div className={cn(
                  "pt-2 border-t",
                  isDarkMode ? "border-neutral-700" : "border-neutral-100"
                )}>
                  <p className="text-[10px] text-neutral-400 italic">
                    {matches.length > 0 
                      ? `Found ${matches.length} instance(s) on this page.`
                      : "Searching for component on this page..."}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Debug Modal */}
      {showDebugModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className={cn(
            "w-full max-w-4xl max-h-[80vh] flex flex-col rounded-xl shadow-2xl overflow-hidden",
            isDarkMode ? "bg-neutral-900 border border-neutral-700" : "bg-white border border-neutral-200"
          )}>
            <div className={cn(
              "flex items-center justify-between p-4 border-b",
              isDarkMode ? "border-neutral-700 bg-neutral-800" : "border-neutral-200 bg-neutral-50"
            )}>
              <div className="flex items-center gap-2">
                <Bug className="w-5 h-5 text-emerald-500" />
                <h2 className="font-bold">BOM Data Debugger</h2>
                <span className={cn(
                  "text-xs px-2 py-0.5 rounded-full",
                  isDarkMode ? "bg-neutral-700 text-neutral-300" : "bg-neutral-200 text-neutral-700"
                )}>
                  {bomData.length} entries
                </span>
              </div>
              <button 
                onClick={() => setShowDebugModal(false)}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  isDarkMode ? "hover:bg-neutral-700" : "hover:bg-neutral-200"
                )}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {bomData.length > 0 ? (
                <pre className={cn(
                  "text-xs font-mono p-4 rounded-lg overflow-x-auto",
                  isDarkMode ? "bg-neutral-950 text-emerald-400" : "bg-neutral-100 text-emerald-700"
                )}>
                  {JSON.stringify(bomData, null, 2)}
                </pre>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-neutral-400 py-12">
                  <FileText className="w-12 h-12 mb-4 opacity-20" />
                  <p>No BOM data loaded yet.</p>
                  <p className="text-sm mt-2 opacity-70">Upload a CSV or TXT file to see the parsed data here.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Error Message Overlay */}
      {error && (
        <div className="fixed bottom-6 right-6 bg-red-600 text-white px-6 py-3 rounded-full shadow-lg flex items-center gap-3 z-[100] animate-bounce">
          <AlertCircle className="w-5 h-5" />
          <span className="text-sm font-medium">{error}</span>
          <button onClick={() => setError(null)} className="ml-2 hover:bg-red-700 rounded-full p-1">
            <ChevronRight className="w-4 h-4 rotate-90" />
          </button>
        </div>
      )}
    </div>
  );
}
