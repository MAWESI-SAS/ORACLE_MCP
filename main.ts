#!/usr/bin/env node
/**
 * ORACLE MCP SERVER
 * Un servidor que implementa el Model Context Protocol (MCP) para interactuar con bases de datos Oracle.
 * Proporciona herramientas para ejecutar consultas, administrar usuarios y explorar la estructura de la base de datos.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import oracledb from "oracledb";

// Configurar oracledb para devolver resultados como objetos en lugar de arrays
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
// Permitir el retorno de valores CLOB y BLOB como String y Buffer
oracledb.fetchAsString = [oracledb.CLOB];
oracledb.fetchAsBuffer = [oracledb.BLOB];

/**
 * Inicialización del servidor MCP con información básica y capacidades
 */
const server = new Server(
    {
        name: "oracle-mcp-server",
        version: "0.1.0",
    },
    {
        capabilities: {
            resources: {},
            tools: {},
        },
    },
);

/**
 * Procesamiento de argumentos de línea de comandos
 * Se espera una cadena de conexión a la base de datos Oracle como único argumento
 */
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Please provide a database connection string as a command-line argument");
    console.error("Format: usuario/contraseña@host:puerto/servicio");
    process.exit(1);
}

const connectionString = args[0];
// Analizamos la cadena de conexión para extraer sus componentes
const connectionParts = connectionString.match(/^(.+)\/(.+)@(.+):(\d+)\/(.+)$/);
if (!connectionParts) {
    console.error("Invalid connection string format. Use: user/password@host:port/service_name");
    process.exit(1);
}

const [, user, password, host, port, serviceName] = connectionParts;

// Creamos una URL base para recursos sin incluir la contraseña por seguridad
const resourceBaseUrl = new URL(`oracle://${user}@${host}:${port}/${serviceName}`);

// Variable para almacenar el pool de conexiones
let pool;

/**
 * Inicializa el pool de conexiones a la base de datos Oracle
 * Configura parámetros como número mínimo y máximo de conexiones
 * Establece tiempos de espera y estadísticas para optimizar el rendimiento
 */
async function initializePool() {
    try {
        // Descomentar la siguiente línea si se necesita configurar el directorio de Oracle Client
        // oracledb.initOracleClient({ libDir: '/path/to/instantclient' });

        pool = await oracledb.createPool({
            user: user,
            password: password,
            connectString: `${host}:${port}/${serviceName}`,
            poolMin: 1,            // Número mínimo de conexiones en el pool
            poolMax: 5,            // Número máximo de conexiones en el pool
            poolIncrement: 1,      // Incremento de nuevas conexiones
            // Configuraciones adicionales para mejorar el rendimiento
            poolTimeout: 60,       // Tiempo en segundos que una conexión puede estar inactiva antes de cerrarse
            queueTimeout: 60000,   // Tiempo en milisegundos que una solicitud puede esperar una conexión
            enableStatistics: true // Habilita estadísticas para monitoreo del pool
        });
        console.error("Oracle connection pool created successfully");
    } catch (err) {
        console.error("Error creating connection pool:", err);
        process.exit(1);
    }
}

/**
 * Función de utilidad para gestionar conexiones a la base de datos
 * Obtiene una conexión del pool, ejecuta el callback y asegura el cierre de la conexión
 * Implementa un patrón de manejo de recursos para garantizar la liberación de conexiones
 * 
 * @param callback - Función que recibe una conexión y realiza operaciones con ella
 * @returns El resultado del callback
 */
async function withConnection(callback) {
    let connection;
    try {
        connection = await pool.getConnection();
        return await callback(connection);
    } catch (err) {
        console.error("Database operation error:", err);
        throw err;
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error("Error closing connection:", err);
            }
        }
    }
}

/**
 * Procesa el resultado de operaciones que no devuelven filas (DDL/DML)
 * Proporciona un formato consistente para las respuestas de estas operaciones
 * 
 * @param result - El resultado de una operación sin resultados de filas
 * @returns Un objeto con información sobre el resultado de la operación
 */
function handleNonQueryResult(result) {
    if (result && result.rowsAffected !== undefined) {
        return {
            message: `Operation completed successfully. Rows affected: ${result.rowsAffected}`,
            rowsAffected: result.rowsAffected
        };
    }
    return { message: "Operation completed successfully" };
}

// Constante para la ruta de acceso a los esquemas
const SCHEMA_PATH = "schema";

/**
 * Manejador para listar recursos (tablas) disponibles en la base de datos
 * Obtiene todas las tablas a las que el usuario tiene acceso, tanto propias como de otros esquemas
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return await withConnection(async (connection) => {
        // Consulta para obtener todas las tablas accesibles por el usuario actual
        // Incluye tablas propias y tablas de otros esquemas con privilegios específicos
        const result = await connection.execute(
            `SELECT table_name 
       FROM user_tables 
       UNION ALL 
       SELECT table_name 
       FROM all_tables 
       WHERE owner != USER 
       AND (owner, table_name) IN (
         SELECT table_owner, table_name 
         FROM user_tab_privs 
         WHERE privilege IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'ALL')
       )
       ORDER BY table_name`
        );

        // Transforma los resultados en formato de recursos MCP
        return {
            resources: result.rows.map((row) => ({
                uri: new URL(`${row.TABLE_NAME}/${SCHEMA_PATH}`, resourceBaseUrl).href,
                mimeType: "application/json",
                name: `"${row.TABLE_NAME}" database schema`,
            })),
        };
    });
});

/**
 * Manejador para leer información detallada de un recurso (tabla)
 * Proporciona metadatos completos incluyendo columnas, claves primarias y foráneas
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    // Extraemos componentes de la URI del recurso
    const resourceUrl = new URL(request.params.uri);
    const pathComponents = resourceUrl.pathname.split("/");
    const schema = pathComponents.pop();
    const tableName = pathComponents.pop();

    if (schema !== SCHEMA_PATH) {
        throw new Error("Invalid resource URI");
    }

    return await withConnection(async (connection) => {
        // Verificamos la propiedad de la tabla (esquema del propietario)
        const ownerQuery = await connection.execute(
            `SELECT owner FROM all_tables WHERE table_name = :tableName AND rownum = 1`,
            [tableName?.toUpperCase() || ""]
        );

        const owner = ownerQuery.rows.length > 0 ? ownerQuery.rows[0].OWNER : null;

        if (!owner) {
            throw new Error(`Table ${tableName} not found`);
        }

        // Obtenemos información detallada de las columnas
        const columnsQuery = await connection.execute(
            `SELECT 
        column_name, 
        data_type, 
        data_length, 
        data_precision, 
        data_scale, 
        nullable, 
        column_id,
        default_length,
        data_default
       FROM all_tab_columns 
       WHERE table_name = :tableName
       AND owner = :owner
       ORDER BY column_id`,
            {
                tableName: (tableName ?? "").toUpperCase(),
                owner: owner
            }
        );

        // Obtenemos información de las claves primarias
        const primaryKeysQuery = await connection.execute(
            `SELECT cols.column_name
       FROM all_constraints cons, all_cons_columns cols
       WHERE cons.constraint_type = 'P'
       AND cons.constraint_name = cols.constraint_name
       AND cons.owner = cols.owner
       AND cols.table_name = :tableName
       AND cons.owner = :owner`,
            {
                tableName: (tableName ?? "").toUpperCase(),
                owner: owner
            }
        );

        // Obtenemos información de las claves foráneas y sus relaciones
        const foreignKeysQuery = await connection.execute(
            `SELECT 
        a.column_name, 
        a.constraint_name,
        c_pk.table_name as referenced_table,
        c_pk.owner as referenced_owner
       FROM all_cons_columns a
       JOIN all_constraints c ON a.owner = c.owner
           AND a.constraint_name = c.constraint_name
       JOIN all_constraints c_pk ON c.r_owner = c_pk.owner
           AND c.r_constraint_name = c_pk.constraint_name
       WHERE c.constraint_type = 'R'
       AND a.table_name = :tableName
       AND c.owner = :owner`,
            {
                tableName: (tableName ?? "").toUpperCase(),
                owner: owner
            }
        );

        // Construimos un objeto con toda la información estructural de la tabla
        const tableInfo = {
            tableName: (tableName ?? "").toUpperCase(),
            owner: owner,
            columns: columnsQuery.rows,
            primaryKeys: primaryKeysQuery.rows.map(row => row.COLUMN_NAME),
            foreignKeys: foreignKeysQuery.rows.map(row => ({
                column: row.COLUMN_NAME,
                constraintName: row.CONSTRAINT_NAME,
                referencedTable: row.REFERENCED_TABLE,
                referencedOwner: row.REFERENCED_OWNER
            }))
        };

        // Devolvemos la información como contenido JSON
        return {
            contents: [
                {
                    uri: request.params.uri,
                    mimeType: "application/json",
                    text: JSON.stringify(tableInfo, null, 2),
                },
            ],
        };
    });
});

/**
 * Manejador para listar las herramientas disponibles en el servidor
 * Define las operaciones que los clientes pueden invocar y sus parámetros
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "query",
                description: "Run a read-only SQL query on Oracle database",
                inputSchema: {
                    type: "object",
                    properties: {
                        sql: { type: "string" },
                    },
                    required: ["sql"]
                },
            },
            {
                name: "execute",
                description: "Execute DDL/DML statements (CREATE, INSERT, UPDATE, etc.) on Oracle database",
                inputSchema: {
                    type: "object",
                    properties: {
                        sql: { type: "string" },
                    },
                    required: ["sql"]
                },
            },
            {
                name: "check_user_exists",
                description: "Check if a user already exists in Oracle",
                inputSchema: {
                    type: "object",
                    properties: {
                        username: { type: "string" },
                    },
                    required: ["username"]
                },
            },
            {
                name: "create_user",
                description: "Create a new Oracle user with basic permissions",
                inputSchema: {
                    type: "object",
                    properties: {
                        username: { type: "string" },
                        password: { type: "string" },
                        tablespace: { type: "string", default: "USERS" },
                        tempTablespace: { type: "string", default: "TEMP" },
                    },
                    required: ["username", "password"]
                },
            },
            {
                name: "grant_privileges",
                description: "Grant privileges to a user",
                inputSchema: {
                    type: "object",
                    properties: {
                        username: { type: "string" },
                        privileges: {
                            type: "array",
                            items: { type: "string" },
                            description: "List of privileges to grant (e.g. CREATE SESSION, CREATE TABLE)"
                        },
                    },
                    required: ["username", "privileges"]
                },
            },
            {
                name: "get_table_data",
                description: "Get sample data from a table",
                inputSchema: {
                    type: "object",
                    properties: {
                        tableName: { type: "string" },
                        limit: { type: "number", default: 10 },
                    },
                    required: ["tableName"]
                },
            }
        ],
    };
});

/**
 * Manejador principal para la ejecución de herramientas
 * Recibe solicitudes para ejecutar operaciones específicas en la base de datos
 * Implementa lógica diferente según la herramienta solicitada
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

    if (toolName === "query") {
        /**
         * Herramienta para ejecutar consultas de solo lectura (SELECT)
         * Establece la transacción como READ ONLY para mayor seguridad
         * Limita el número de filas devueltas para evitar sobrecarga
         */
        const sql = request.params.arguments?.sql as string;

        return await withConnection(async (connection) => {
            try {
                // Establecer la sesión como de solo lectura por seguridad
                await connection.execute("SET TRANSACTION READ ONLY");

                const result = await connection.execute(sql, [], {
                    maxRows: 1000,  // Límite para evitar resultados excesivamente grandes
                });

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(result.rows, null, 2)
                    }],
                    isError: false,
                };
            } finally {
                // Asegurar rollback de cualquier transacción pendiente
                try {
                    await connection.execute("ROLLBACK");
                } catch (err) {
                    console.error("Error during rollback:", err);
                }
            }
        });
    }

    else if (toolName === "execute") {
        /**
         * Herramienta para ejecutar sentencias DDL/DML (CREATE, INSERT, UPDATE, etc.)
         * Utiliza autocommit para asegurar que los cambios se persistan
         * Proporciona información detallada sobre errores para facilitar la depuración
         */
        const sql = request.params.arguments?.sql as string;

        return await withConnection(async (connection) => {
            try {
                // Para operaciones de modificación se requiere autocommit
                const result = await connection.execute(sql, [], { autoCommit: true });

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(handleNonQueryResult(result), null, 2)
                    }],
                    isError: false,
                };
            } catch (error) {
                // Proporcionar información detallada sobre el error para facilitar la resolución
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            error: error.message,
                            errorCode: error.errorNum,
                            suggestion: "Verifique la sintaxis SQL y los permisos"
                        }, null, 2)
                    }],
                    isError: true,
                };
            }
        });
    }

    else if (toolName === "check_user_exists") {
        /**
         * Herramienta para verificar si un usuario existe en la base de datos
         * Convierte el nombre de usuario a mayúsculas para coincidir con el estándar de Oracle
         */
        const username = (request.params.arguments?.username as string).toUpperCase();

        return await withConnection(async (connection) => {
            const result = await connection.execute(
                `SELECT COUNT(*) AS EXIST_COUNT FROM dba_users WHERE username = :username`,
                [username]
            );

            const exists = result.rows[0].EXIST_COUNT > 0;

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        username: username,
                        exists: exists
                    }, null, 2)
                }],
                isError: false,
            };
        });
    }

    else if (toolName === "create_user") {
        /**
         * Herramienta para crear un nuevo usuario en la base de datos
         * Asigna tablespaces por defecto y cuotas de almacenamiento
         * Verifica primero si el usuario ya existe para evitar errores
         */
        const username = (request.params.arguments?.username as string).toUpperCase();
        const password = request.params.arguments?.password as string;
        const tablespace = (request.params.arguments?.tablespace as string) || "USERS";
        const tempTablespace = (request.params.arguments?.tempTablespace as string) || "TEMP";

        return await withConnection(async (connection) => {
            try {
                // Verificación previa para evitar intentar crear usuarios duplicados
                const checkResult = await connection.execute(
                    `SELECT COUNT(*) AS EXIST_COUNT FROM dba_users WHERE username = :username`,
                    [username]
                );

                if (checkResult.rows[0].EXIST_COUNT > 0) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                error: `User ${username} already exists`,
                                suggestion: "Use a different username or drop the existing user first"
                            }, null, 2)
                        }],
                        isError: true,
                    };
                }

                // Proceso de creación de usuario en pasos separados para mejor control
                await connection.execute(
                    `CREATE USER ${username} IDENTIFIED BY "${password}"`,
                    [],
                    { autoCommit: true }
                );

                // Configuración de tablespaces y cuotas para el nuevo usuario
                await connection.execute(
                    `ALTER USER ${username} DEFAULT TABLESPACE ${tablespace} 
           TEMPORARY TABLESPACE ${tempTablespace} 
           QUOTA UNLIMITED ON ${tablespace}`,
                    [],
                    { autoCommit: true }
                );

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            message: `User ${username} created successfully`,
                            nextStep: "Use grant_privileges tool to assign permissions to the user"
                        }, null, 2)
                    }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            error: error.message,
                            errorCode: error.errorNum,
                            suggestion: "Verifique la sintaxis y los permisos para crear usuarios"
                        }, null, 2)
                    }],
                    isError: true,
                };
            }
        });
    }

    else if (toolName === "grant_privileges") {
        /**
         * Herramienta para otorgar privilegios a un usuario existente
         * Permite otorgar múltiples privilegios en una sola operación
         * Procesa cada privilegio individualmente para mejor manejo de errores
         */
        const username = (request.params.arguments?.username as string).toUpperCase();
        const privileges = request.params.arguments?.privileges as string[];

        return await withConnection(async (connection) => {
            try {
                // Verificación de la existencia del usuario antes de intentar asignar privilegios
                const checkResult = await connection.execute(
                    `SELECT COUNT(*) AS EXIST_COUNT FROM dba_users WHERE username = :username`,
                    [username]
                );

                if (checkResult.rows[0].EXIST_COUNT === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                error: `User ${username} does not exist`,
                                suggestion: "Create the user first using create_user tool"
                            }, null, 2)
                        }],
                        isError: true,
                    };
                }

                // Procesamiento individual de cada privilegio para mejor control y reporte
                const results: Array<{ privilege: string; granted: boolean; error?: string }> = [];

                for (const privilege of privileges) {
                    try {
                        await connection.execute(
                            `GRANT ${privilege} TO ${username}`,
                            [],
                            { autoCommit: true }
                        );
                        results.push({ privilege, granted: true });
                    } catch (error: any) {
                        results.push({
                            privilege,
                            granted: false,
                            error: error.message
                        });
                    }
                }

                // Resumen detallado del resultado de cada operación de asignación de privilegios
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            message: `Privileges processed for user ${username}`,
                            results: results
                        }, null, 2)
                    }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            error: error.message,
                            errorCode: error.errorNum,
                            suggestion: "Verifique los permisos y la sintaxis de los privilegios"
                        }, null, 2)
                    }],
                    isError: true,
                };
            }
        });
    }

    else if (toolName === "get_table_data") {
        /**
         * Herramienta para obtener datos de muestra de una tabla
         * Limita la cantidad de filas devueltas para evitar sobrecarga
         * Determina automáticamente el esquema propietario de la tabla
         */
        const tableName = request.params.arguments?.tableName as string;
        const limit = (request.params.arguments?.limit as number) || 10;

        return await withConnection(async (connection) => {
            try {
                // Configurar como transacción de solo lectura por seguridad
                await connection.execute("SET TRANSACTION READ ONLY");

                // Verificación de existencia de la tabla y obtención de su propietario
                const tableCheck = await connection.execute(
                    `SELECT owner FROM all_tables WHERE table_name = :tableName`,
                    [tableName.toUpperCase()]
                );

                if (tableCheck.rows.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                error: `Table ${tableName} does not exist or you don't have access to it`,
                            }, null, 2)
                        }],
                        isError: true,
                    };
                }

                // Construcción del nombre completo de la tabla (con esquema si es necesario)
                const owner = tableCheck.rows[0].OWNER;
                const fullTableName = owner === user.toUpperCase() ?
                    tableName.toUpperCase() :
                    `${owner}.${tableName.toUpperCase()}`;

                // Consulta de datos limitada por el parámetro de límite
                const result = await connection.execute(
                    `SELECT * FROM ${fullTableName} WHERE ROWNUM <= :limit`,
                    [limit],
                    { maxRows: limit }
                );

                // Respuesta con metadatos y datos de la tabla
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            tableName: tableName.toUpperCase(),
                            owner: owner,
                            rowCount: result.rows.length,
                            data: result.rows
                        }, null, 2)
                    }],
                    isError: false,
                };
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            error: error.message,
                            errorCode: error.errorNum,
                            suggestion: "Verifique el nombre de la tabla y sus permisos de acceso"
                        }, null, 2)
                    }],
                    isError: true,
                };
            } finally {
                // Asegurar que se haga rollback para liberar bloqueos
                try {
                    await connection.execute("ROLLBACK");
                } catch (err) {
                    console.error("Error during rollback:", err);
                }
            }
        });
    }

    else {
        // Manejo de herramientas desconocidas
        throw new Error(`Unknown tool: ${toolName}`);
    }
});

/**
 * Inicialización y ejecución del servidor
 * Establece el pool de conexiones y configura el transporte para comunicación
 */
async function runServer() {
    // Inicializa el pool de conexiones a Oracle
    await initializePool();
    console.error("Oracle MCP Server starting...");
    // Configura el transporte para comunicación mediante stdio
    const transport = new StdioServerTransport();
    console.error("Connected to transport, waiting for requests...");
    // Conecta el servidor al transporte y comienza a escuchar peticiones
    await server.connect(transport);
}

// Ejecución del servidor con manejo de errores a nivel global
runServer().catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
});