const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const path = require("path");

const app = express();

const VERCEL_API = "https://api.vercel.com";

const upload = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: 4 * 1024 * 1024
    }
});


/* =========================================
   STATIC FRONTEND
========================================= */

const publicDirectory = path.join(
    __dirname,
    "../public"
);

app.use(
    express.static(publicDirectory)
);


/* =========================================
   ROOT
========================================= */

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            publicDirectory,
            "index.html"
        )
    );

});


/* =========================================
   VERCEL REQUEST HELPER
========================================= */

async function vercelRequest(
    apiPath,
    options = {}
) {

    const token =
        process.env.BLACKBOX_VERCEL_TOKEN;

    if (!token) {

        throw new Error(
            "BLACKBOX_VERCEL_TOKEN is not configured."
        );
    }


    const response = await fetch(
        VERCEL_API + apiPath,
        {
            ...options,

            headers: {
                Authorization:
                    `Bearer ${token}`,

                "Content-Type":
                    "application/json",

                ...(options.headers || {})
            }
        }
    );


    let data = {};

    try {

        data =
            await response.json();

    } catch {

        data = {};

    }


    return {
        response,
        data
    };
}


/* =========================================
   PROJECT NAME
========================================= */

function normalizeProjectName(name) {

    return String(name || "")
        .trim()
        .toLowerCase();

}


function isValidProjectName(name) {

    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
        name
    );

}


/* =========================================
   ZIP PATH NORMALIZATION
========================================= */

function normalizePath(filePath) {

    return String(filePath || "")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .split("/")
        .filter(
            part =>
                part &&
                part !== "." &&
                part !== ".."
        )
        .join("/");

}


/* =========================================
   ENV FILE
========================================= */

function isEnvFile(filePath) {

    const normalized =
        normalizePath(filePath)
            .toLowerCase();

    const baseName =
        path.posix.basename(
            normalized
        );

    return (
        baseName === ".env" ||
        baseName === ".env.local" ||
        baseName === ".env.production" ||
        baseName === ".env.development" ||
        baseName === ".env.preview"
    );

}


/* =========================================
   IGNORED FILES
========================================= */

function isIgnored(filePath) {

    const normalized =
        normalizePath(filePath);

    return (
        normalized === ".git" ||
        normalized.startsWith(".git/") ||

        normalized === "node_modules" ||
        normalized.startsWith("node_modules/")
    );

}


/* =========================================
   PARSE ENV
========================================= */

function parseEnv(content) {

    const variables = {};

    const lines =
        String(content || "")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split("\n");


    for (
        let line of lines
    ) {

        line = line.trim();


        if (!line) {
            continue;
        }


        if (line.startsWith("#")) {
            continue;
        }


        if (
            line.startsWith("export ")
        ) {

            line =
                line
                    .slice(7)
                    .trim();

        }


        const equals =
            line.indexOf("=");


        if (equals === -1) {
            continue;
        }


        const key =
            line
                .slice(0, equals)
                .trim();


        let value =
            line
                .slice(equals + 1)
                .trim();


        if (
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(
                key
            )
        ) {

            continue;

        }


        if (
            (
                value.startsWith('"') &&
                value.endsWith('"')
            ) ||
            (
                value.startsWith("'") &&
                value.endsWith("'")
            )
        ) {

            value =
                value.slice(1, -1);

        }


        variables[key] = value;

    }


    return variables;
}


/* =========================================
   ENV FROM WEBSITE
========================================= */

function parseEnvironmentText(
    content
) {

    return parseEnv(
        content
    );

}


/* =========================================
   CHECK SUBDOMAIN
========================================= */

app.get(
    "/check-name",
    async (req, res) => {

        try {

            const name =
                normalizeProjectName(
                    req.query.name
                );


            if (!name) {

                return res.status(400).json({
                    error:
                        "Subdomain is required."
                });

            }


            if (
                !isValidProjectName(
                    name
                )
            ) {

                return res.status(400).json({
                    error:
                        "Invalid subdomain. Use only lowercase letters, numbers, and hyphens."
                });

            }


            const {
                response,
                data
            } =
                await vercelRequest(
                    "/v9/projects/" +
                    encodeURIComponent(name)
                );


            const url =
                `https://${name}.vercel.app`;


            if (response.ok) {

                return res.json({

                    available: false,

                    name,

                    url

                });

            }


            if (
                response.status === 404
            ) {

                return res.json({

                    available: true,

                    name,

                    url

                });

            }


            return res.status(
                response.status
            ).json({

                error:
                    data?.error?.message ||
                    "Unable to check subdomain."

            });

        } catch (error) {

            console.error(
                "Name check error:",
                error
            );


            return res.status(500).json({

                error:
                    error.message ||
                    "Internal server error."

            });

        }

    }
);


/* =========================================
   CREATE VERCEL PROJECT
========================================= */

async function createProject(
    name
) {

    const {
        response,
        data
    } =
        await vercelRequest(
            "/v10/projects",
            {
                method: "POST",

                body: JSON.stringify({
                    name
                })
            }
        );


    if (!response.ok) {

        const error =
            new Error(
                data?.error?.message ||
                "Failed to create Vercel project."
            );


        error.status =
            response.status;


        error.vercel =
            data;


        throw error;

    }


    return data;
}


/* =========================================
   ADD ENVIRONMENT VARIABLE
========================================= */

async function addEnvironmentVariable(
    projectId,
    key,
    value
) {

    const {
        response,
        data
    } =
        await vercelRequest(
            `/v10/projects/${encodeURIComponent(projectId)}/env`,
            {
                method: "POST",

                body: JSON.stringify({

                    key,

                    value,

                    type: "encrypted",

                    target: [
                        "production",
                        "preview",
                        "development"
                    ]

                })
            }
        );


    if (!response.ok) {

        /*
         * 409 = variable already exists.
         *
         * We don't silently pretend it was
         * updated. The deployment can still
         * continue because the variable already
         * exists on the project.
         */

        if (
            response.status === 409
        ) {

            return {
                exists: true
            };

        }


        const error =
            new Error(
                data?.error?.message ||
                `Failed to add environment variable: ${key}`
            );


        error.status =
            response.status;


        error.vercel =
            data;


        throw error;

    }


    return data;
}


/* =========================================
   DEPLOY
========================================= */

app.post(
    "/deploy",
    upload.single("file"),

    async (req, res) => {

        try {

            /* -----------------------------
               TOKEN
            ----------------------------- */

            if (
                !process.env.BLACKBOX_VERCEL_TOKEN
            ) {

                return res.status(500).json({

                    error:
                        "BLACKBOX_VERCEL_TOKEN is not configured."

                });

            }


            /* -----------------------------
               ZIP
            ----------------------------- */

            if (!req.file) {

                return res.status(400).json({

                    error:
                        "No ZIP file was uploaded."

                });

            }


            const originalName =
                req.file.originalname || "";


            if (
                !originalName
                    .toLowerCase()
                    .endsWith(".zip")
            ) {

                return res.status(400).json({

                    error:
                        "Only ZIP files are supported."

                });

            }


            /* -----------------------------
               PROJECT NAME
            ----------------------------- */

            const name =
                normalizeProjectName(
                    req.body.name
                );


            if (!name) {

                return res.status(400).json({

                    error:
                        "Subdomain is required."

                });

            }


            if (
                !isValidProjectName(name)
            ) {

                return res.status(400).json({

                    error:
                        "Invalid subdomain. Use only lowercase letters, numbers, and hyphens."

                });

            }


            /* -----------------------------
               READ ZIP
            ----------------------------- */

            let zip;

            try {

                zip =
                    new AdmZip(
                        req.file.buffer
                    );

            } catch {

                return res.status(400).json({

                    error:
                        "The uploaded file is not a valid ZIP."

                });

            }


            const entries =
                zip.getEntries();


            const files = [];

            const zipEnvironment = {};


            /* -----------------------------
               PROCESS ZIP
            ----------------------------- */

            for (
                const entry of entries
            ) {

                if (
                    entry.isDirectory
                ) {

                    continue;

                }


                const filePath =
                    normalizePath(
                        entry.entryName
                    );


                if (!filePath) {
                    continue;
                }


                if (
                    isIgnored(filePath)
                ) {

                    continue;

                }


                /*
                 * .env files are NEVER
                 * uploaded to Vercel.
                 */

                if (
                    isEnvFile(filePath)
                ) {

                    const envContent =
                        entry
                            .getData()
                            .toString(
                                "utf8"
                            );


                    const parsed =
                        parseEnv(
                            envContent
                        );


                    Object.assign(
                        zipEnvironment,
                        parsed
                    );


                    continue;

                }


                const data =
                    entry.getData();


                files.push({

                    file:
                        filePath,

                    data:
                        data.toString(
                            "base64"
                        ),

                    encoding:
                        "base64"

                });

            }


            /* -----------------------------
               DEPLOYABLE FILE CHECK
            ----------------------------- */

            if (
                files.length === 0
            ) {

                return res.status(400).json({

                    error:
                        "The ZIP contains no deployable files."

                });

            }


            /* -----------------------------
               CHECK PROJECT AGAIN
            ----------------------------- */

            const existing =
                await vercelRequest(
                    "/v9/projects/" +
                    encodeURIComponent(name)
                );


            if (
                existing.response.ok
            ) {

                return res.status(409).json({

                    error:
                        "Subdomain is already in use.",

                    warning:
                        true,

                    url:
                        `https://${name}.vercel.app`

                });

            }


            if (
                existing.response.status !==
                404
            ) {

                return res.status(
                    existing.response.status
                ).json({

                    error:
                        existing
                            .data
                            ?.error
                            ?.message ||
                        "Could not verify subdomain."

                });

            }


            /* -----------------------------
               CREATE PROJECT
            ----------------------------- */

            const project =
                await createProject(
                    name
                );


            const projectId =
                project.id;


            /* -----------------------------
               ENV FROM ZIP
            ----------------------------- */

            const environmentVariables = {
                ...zipEnvironment
            };


            /* -----------------------------
               ENV FROM UI
            ----------------------------- */

            const uiEnvironment =
                parseEnvironmentText(
                    req.body.environment
                );


            /*
             * UI variables override
             * variables from .env.
             */

            Object.assign(
                environmentVariables,
                uiEnvironment
            );


            /* -----------------------------
               ADD ENV
            ----------------------------- */

            let envCount = 0;


            for (
                const [key, value]
                of Object.entries(
                    environmentVariables
                )
            ) {

                await addEnvironmentVariable(
                    projectId,
                    key,
                    value
                );


                envCount++;

            }


            /* -----------------------------
               CREATE DEPLOYMENT
            ----------------------------- */

            const {
                response:
                    deploymentResponse,

                data:
                    deployment
            } =
                await vercelRequest(
                    "/v13/deployments",
                    {
                        method: "POST",

                        body:
                            JSON.stringify({

                                name,

                                project:
                                    name,

                                files,

                                projectSettings: {
                                    framework: null
                                }

                            })
                    }
                );


            if (
                !deploymentResponse.ok
            ) {

                return res.status(
                    deploymentResponse.status
                ).json({

                    error:
                        deployment
                            ?.error
                            ?.message ||
                        "Vercel deployment failed."

                });

            }


            /* -----------------------------
               RESULT
            ----------------------------- */

            const url =
                `https://${name}.vercel.app`;


            return res.json({

                success:
                    true,

                id:
                    deployment.id,

                projectId,

                name,

                url,

                environmentVariables:
                    envCount

            });

        } catch (error) {

            console.error(
                "Deployment error:",
                error
            );


            return res.status(
                error.status || 500
            ).json({

                error:
                    error.message ||
                    "Deployment failed."

            });

        }

    }
);


/* =========================================
   MULTER ERROR HANDLER
========================================= */

app.use(
    (error, req, res, next) => {

        if (
            error?.code ===
            "LIMIT_FILE_SIZE"
        ) {

            return res.status(413).json({

                error:
                    "ZIP file is too large. Maximum size is 50 MB."

            });

        }


        console.error(
            "Upload error:",
            error
        );


        return res.status(500).json({

            error:
                "Upload failed."

        });

    }
);


/* =========================================
   VERCEL SERVERLESS EXPORT
========================================= */

/*
 * IMPORTANT:
 *
 * No PORT.
 * No app.listen().
 *
 * Vercel invokes this Express app
 * as a serverless function.
 */

module.exports = app;
