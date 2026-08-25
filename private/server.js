const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");

const app = express();

const PORT = process.env.PORT || 3000;
const VERCEL_API = "https://api.vercel.com";

const upload = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: 50 * 1024 * 1024
    }
});


/* =========================================
   STATIC FRONTEND
========================================= */

app.use(
    express.static("public")
);


/* =========================================
   VERCEL REQUEST HELPER
========================================= */

async function vercelRequest(
    path,
    options = {}
) {

    if (!process.env.VERCEL_TOKEN) {
        throw new Error(
            "VERCEL_TOKEN is not configured."
        );
    }

    const response = await fetch(
        VERCEL_API + path,
        {
            ...options,

            headers: {
                Authorization:
                    `Bearer ${process.env.VERCEL_TOKEN}`,

                "Content-Type":
                    "application/json",

                ...(options.headers || {})
            }
        }
    );

    let data = {};

    try {
        data = await response.json();
    } catch {
        data = {};
    }

    return {
        response,
        data
    };
}


/* =========================================
   PROJECT NAME VALIDATION
========================================= */

function normalizeProjectName(name) {

    return String(name || "")
        .trim()
        .toLowerCase();
}


function isValidProjectName(name) {

    /*
        Vercel project names are intentionally
        restricted to a safe hostname-like format.
    */

    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
        name
    );
}


/* =========================================
   ZIP PATH SECURITY
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
   ENV FILE DETECTION
========================================= */

function isEnvFile(filePath) {

    const normalized =
        filePath.toLowerCase();

    return (
        normalized === ".env" ||
        normalized === ".env.local" ||
        normalized === ".env.production" ||
        normalized === ".env.development" ||
        normalized === ".env.preview"
    );
}


/* =========================================
   IGNORED FILES
========================================= */

function isIgnored(filePath) {

    return (
        filePath.startsWith(".git/") ||
        filePath.startsWith("node_modules/") ||
        filePath === ".git" ||
        filePath === "node_modules"
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
            .split("\n");

    for (let line of lines) {

        line = line.trim();

        if (!line) {
            continue;
        }

        if (line.startsWith("#")) {
            continue;
        }

        /*
            Support:

            KEY=value
            KEY="value"
            KEY='value'
        */

        if (line.startsWith("export ")) {
            line =
                line.slice(7).trim();
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
   PARSE ENV TEXT FROM UI
========================================= */

function parseEnvironmentText(
    content
) {

    return parseEnv(content);
}


/* =========================================
   CHECK PROJECT NAME
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


            if (!isValidProjectName(name)) {

                return res.status(400).json({
                    error:
                        "Invalid subdomain. Use only lowercase letters, numbers, and hyphens."
                });
            }


            const {
                response,
                data
            } = await vercelRequest(
                "/v9/projects/" +
                encodeURIComponent(name)
            );


            if (response.ok) {

                return res.json({

                    available: false,

                    name,

                    url:
                        `https://${name}.vercel.app`
                });
            }


            /*
                A 404 means the project does not
                currently exist for this token/team.
            */

            if (response.status === 404) {

                return res.json({

                    available: true,

                    name,

                    url:
                        `https://${name}.vercel.app`
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
    } = await vercelRequest(
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
    } = await vercelRequest(
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


    /*
        If the variable already exists,
        update it instead of failing the
        whole deployment.
    */

    if (
        !response.ok &&
        response.status !== 409
    ) {

        throw new Error(
            data?.error?.message ||
            `Failed to add environment variable: ${key}`
        );
    }

    return data;
}


/* =========================================
   DEPLOY ZIP
========================================= */

app.post(
    "/deploy",
    upload.single("file"),

    async (req, res) => {

        let project = null;

        try {

            /* -----------------------------
               CHECK TOKEN
            ----------------------------- */

            if (!process.env.VERCEL_TOKEN) {

                return res.status(500).json({
                    error:
                        "VERCEL_TOKEN is not configured."
                });
            }


            /* -----------------------------
               CHECK ZIP
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


            if (!isValidProjectName(name)) {

                return res.status(400).json({
                    error:
                        "Invalid subdomain."
                });
            }


            /* -----------------------------
               READ ZIP
            ----------------------------- */

            const zip =
                new AdmZip(
                    req.file.buffer
                );


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

                if (entry.isDirectory) {
                    continue;
                }


                const filePath =
                    normalizePath(
                        entry.entryName
                    );


                if (!filePath) {
                    continue;
                }


                if (isIgnored(filePath)) {
                    continue;
                }


                /*
                    .env is NEVER uploaded
                    to the deployment.
                */

                if (
                    isEnvFile(filePath)
                ) {

                    const envContent =
                        entry
                            .getData()
                            .toString("utf8");


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
               CHECK FILES
            ----------------------------- */

            if (files.length === 0) {

                return res.status(400).json({
                    error:
                        "The ZIP contains no deployable files."
                });
            }


            /* -----------------------------
               CHECK PROJECT AGAIN
               TO REDUCE RACE CONDITIONS
            ----------------------------- */

            const existing =
                await vercelRequest(
                    "/v9/projects/" +
                    encodeURIComponent(name)
                );


            if (existing.response.ok) {

                return res.status(409).json({

                    error:
                        "Subdomain is already in use.",

                    warning: true,

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

            project =
                await createProject(
                    name
                );


            const projectId =
                project.id;


            /* -----------------------------
               ENV FROM UI
            ----------------------------- */

            const uiEnvironment =
                parseEnvironmentText(
                    req.body.environment
                );


            /*
                UI variables overwrite
                variables from ZIP when
                they have the same name.
            */

            const environmentVariables = {
                ...zipEnvironment,
                ...uiEnvironment
            };


            /* -----------------------------
               ADD ENV VARIABLES
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
               DEPLOY
            ----------------------------- */

            const {
                response:
                    deploymentResponse,

                data:
                    deployment
            } = await vercelRequest(
                "/v13/deployments",
                {
                    method: "POST",

                    body: JSON.stringify({

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

                return res
                    .status(
                        deploymentResponse.status
                    )
                    .json({

                        error:
                            deployment
                                ?.error
                                ?.message ||
                            "Vercel deployment failed.",

                        details:
                            deployment
                    });
            }


            /* -----------------------------
               URL
            ----------------------------- */

            const url =
                `https://${name}.vercel.app`;


            return res.json({

                success: true,

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


            /*
                Don't expose the Vercel
                token or request headers.
            */

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
   MULTER ERRORS
========================================= */

app.use(
    (error, req, res, next) => {

        if (
            error?.code ===
            "LIMIT_FILE_SIZE"
        ) {

            return res
                .status(413)
                .json({

                    error:
                        "ZIP file is too large. Maximum size is 50 MB."
                });
        }


        console.error(error);


        return res
            .status(500)
            .json({

                error:
                    "Upload failed."
            });
    }
);


/* =========================================
   START
========================================= */

app.listen(
    PORT,
    () => {

        console.log(
            `BlackBox running on port ${PORT}`
        );
    }
);