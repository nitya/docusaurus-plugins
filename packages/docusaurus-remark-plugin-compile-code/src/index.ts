/// <refere
import visit from "unist-util-visit";
import type { Code, Image } from "mdast";
import type { Plugin } from "unified";
import type { Parent } from "unist";
import {
    ensureDirSync,
    writeFileSync,
    existsSync,
    readJSONSync,
    removeSync,
    writeJSONSync,
    readFileSync,
} from "fs-extra";
import { join, resolve, basename, dirname } from "node:path";
import {
    CustomLangOptions,
    LangOptions,
    LangResult,
    PluginOptions,
    ToolLangOptions,
} from "./types";
import hashCode from "./hash";
import { spawnSync } from "child_process";
import { minimatch } from "minimatch";

const RESULT_FILE = "result.json";

function readCachedResult(cwd: string): LangResult | undefined {
    const isProd = process.env.NODE_ENV === "production";
    if (!isProd) return undefined;

    // cache lookup
    const cached = join(cwd, RESULT_FILE);
    if (existsSync(cached)) {
        try {
            const res = readJSONSync(cached) as LangResult;
            return res;
        } catch (e) {
            // invalid file, delete folder
            removeSync(cwd);
        }
    }
    return undefined;
}

async function compileCode(
    cwd: string,
    source: string,
    meta: string,
    langOptions: LangOptions,
    cache: boolean
): Promise<LangResult | undefined> {
    let result = cache && readCachedResult(cwd);
    if (result) return result;

    const { prefix } = langOptions;
    const psource =
        !prefix || source.indexOf(prefix) > -1
            ? source
            : prefix + "\n\n" + source;

    ensureDirSync(cwd);
    result = await compileCodeNodeCache(cwd, psource, meta, langOptions);

    // cache on disk
    if (result && cache) {
        writeJSONSync(join(cwd, RESULT_FILE), result, { spaces: 2 });
    }
    return result;
}

async function compileCodeNodeCache(
    cwd: string,
    source: string,
    meta: string,
    langOptions: LangOptions
): Promise<LangResult | undefined> {
    const { timeout, lang } = langOptions;

    // custom function
    const { compile } = langOptions as CustomLangOptions;
    if (compile) {
        try {
            return await compile(source, {
                ...langOptions,
                meta,
                cwd,
            });
        } catch (e) {
            return {
                error: e + "",
            };
        }
    }

    // Tool
    const {
        extension,
        command,
        nodeBin,
        args = [],
        successReturnCode = 0,
        ignoreReturnCode,
        outputFiles = [],
    } = langOptions as ToolLangOptions;
    if (command || nodeBin) {
        const ifn = `input.${extension || lang}`;
        const iargs = [...args, ifn];
        ensureDirSync(cwd);
        writeFileSync(join(cwd, ifn), source);
        writeJSONSync(join(cwd, "options.json"), {
            ...langOptions,
            meta,
        });

        // compile tool
        let cmd: string = command || "";
        if (nodeBin) {
            iargs.unshift(resolve(join("node_modules", ".bin", nodeBin)));
            cmd = "node";
        } else if (/\.m?js/.test(cmd)) {
            iargs.unshift(resolve(cmd));
            cmd = "node";
        }
        writeFileSync(join(cwd, "run.sh"), `${cmd} ${iargs.join(" ")}`);
        try {
            const res = spawnSync(cmd, iargs, {
                timeout,
                cwd,
            });
            let error = res.error?.message || "";
            if (
                !ignoreReturnCode &&
                res.status !== successReturnCode &&
                !res.stderr
            )
                error += `\exit code: ${res.status}`;
            const result: LangResult = {
                stdout: res.stdout?.toString() || "",
                stderr: res.stderr?.toString() || "",
                error,
            };

            if (outputFiles) {
                result.nodes = outputFiles
                    .filter((fn) => existsSync(join(cwd, fn)))
                    .map((fn) => {
                        console.log({ fn });
                        if (/\.(svg|png|jpg|jpeg$)/i.test(fn)) {
                            return <Image>{
                                type: "image",
                                alt: fn,
                                url: join(cwd, fn),
                            };
                        } else {
                            const text = readFileSync(join(cwd, fn), {
                                encoding: "utf-8",
                            });
                            return <Code>{
                                type: "code",
                                meta: `tabs title=${JSON.stringify(fn)}`,
                                value: text,
                            };
                        }
                    });
            }

            return result;
        } catch (e) {
            return {
                stderr: e + "",
                error: "tool execution failed",
            } as LangResult;
        }
    }

    // unknown configuration
    return {
        error: "invalid configuration",
    };
}

function parseMeta(meta: string = "") {
    const skip = /\s?skip\s?/i.test(meta);
    const ignoreErrors = /\s?ignore-?errors\s?/i.test(meta);
    return { skip, ignoreErrors };
}

const plugin: Plugin<[PluginOptions?]> = (options = undefined) => {
    const {
        cachePath = "./.docusaurus/docusaurus-remark-plugin-compile-code/cache/",
        outputPath = "./.docusaurus/docusaurus-remark-plugin-compile-code/src/",
        langs = [],
        cache = !process.env.RISE_COMPILE_CODE_NO_CACHE,
        failFast,
    } = options || {};

    return async (root, vfile) => {
        let snippet = 0;
        const { history } = vfile;
        const fpath = vfile.path || history[history.length - 1] || "unknown";
        const fbase = basename(fpath);

        let errors = 0;
        const visited = new Set<Code>(); // visit called twice on async
        const todo: {
            node: Code;
            parent: Parent | undefined;
        }[] = [];
        // collect all nodes
        visit(root, "code", (node: Code, _, parent) => {
            if (!visited.has(node)) {
                visited.add(node);
                todo.push({ node, parent });
            }
        });

        // render
        for (const { node, parent } of todo) {
            if (!parent) continue;
            const { lang, meta, value } = node;
            if (!lang) return;
            const langOptions = langs.find(
                (o) =>
                    o.lang === lang &&
                    (!o.meta || (meta || "").indexOf(o.meta) > -1)
            );
            if (!langOptions) continue;
            const { skip, ignoreErrors: ignoreErrorsMeta } = parseMeta(
                meta || ""
            );
            if (skip) continue;

            const {
                outputMeta,
                outputLang,
                inputLang,
                ignoreErrors: ignoreErrorsLang,
                excludedFiles,
            } = langOptions;

            if (
                vfile.path !== undefined &&
                excludedFiles?.some((excluded) =>
                    minimatch(vfile.path || "", excluded)
                )
            ) {
                continue;
            }

            // save source in tree
            snippet++;
            const fn = join(outputPath, fbase, `code${snippet}.${lang}`);
            ensureDirSync(dirname(fn));
            writeFileSync(fn, value, { encoding: "utf-8" });

            // compute output
            let nextIndex = parent.children.indexOf(node) + 1;
            const ignoreErrors = ignoreErrorsLang || ignoreErrorsMeta;
            const hash = hashCode(value, meta || "", langOptions);
            const cwd = join(cachePath, lang, hash);
            const res = await compileCode(
                cwd,
                value,
                meta || "",
                langOptions,
                cache
            );
            const { stdout, stderr, error, nodes } = res || {};
            const out: (string | undefined)[] = [
                stdout?.trimEnd(),
                stderr ? `-- error\n${stderr.trimEnd()}` : undefined,
                error,
            ].filter((s) => !!s);
            if (out?.length) {
                if (inputLang) node.lang = inputLang;
                parent.children.splice(nextIndex++, 0, <Code>{
                    type: "code",
                    lang: outputLang,
                    meta: outputMeta + ` title="Output"`,
                    value: out.join("\n"),
                });
            }

            if (nodes?.length) {
                parent.children.splice(nextIndex, 0, ...nodes);
                nextIndex += nodes.length;
            }

            if (!ignoreErrors && res?.error) {
                errors++;
                console.error(`${vfile.path}: ${res.error}`);
                console.debug(value);

                if (failFast)
                    throw new Error("error while compiling code snippet");
            }
        }

        if (errors) throw new Error("errors while compile code snippets");
    };
};

// To continue supporting `require('...')` without the `.default` ㄟ(▔,▔)ㄏ
// TODO change to export default after migrating to ESM
export = plugin;
