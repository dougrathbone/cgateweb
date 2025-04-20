# C-Gate Manual (Selected Sections for API Understanding)

## 2. About C-Gate

### 2.1 What is C-Gate?
C-Gate is a software package that monitors and controls components of the Clipsal C-Bus wiring system[cite: 3015]. It runs on a PC or server to provide high-speed monitoring and control of multiple C-Bus networks[cite: 3016]. It allows other C-Bus front-end software or building management systems high-level control and monitoring[cite: 3017]. C-Gate uses TCP/IP interfaces to support multiple C-Bus networks, multiple connections from front-end systems, and simple connection to web servers for internet-based control[cite: 3018].

### 2.3 How does C-Gate work with C-Bus?
C-Gate connects to C-Bus networks via interfaces like the C-Bus PC Interface (PCI), C-Bus Network Interface (CNI), modem, or TCP/IP terminal server[cite: 3029]. Once connected, it scans the network, builds an object model of units, and listens for monitoring events to keep the model updated[cite: 3030, 3031, 3032]. Applications connect to C-Gate's Command Interface to issue commands (ON, OFF, RAMP, GET, SET, etc.) and query object status[cite: 3035]. C-Gate also provides event, status, and configuration interfaces for real-time event streams[cite: 3036].

## 3. Quick Start Guide (Relevant Concepts)

### 3.2 Concepts
* **C-Bus Devices/Units**: Hardware modules connected via C-Bus cable[cite: 3048].
* **C-Bus Network**: A group of C-Bus Devices wired together[cite: 3049].
* **C-Bus Bridge**: Connects two C-Bus Networks[cite: 3050].
* **Project**: A group of C-Bus Networks operated together by C-Gate or C-Bus Toolkit[cite: 3051].

### 3.8 Connect To C-Gate
You can connect to the C-Gate command interface using a Telnet client, typically on port 20023[cite: 3108, 3119]. The C-Gate installation provides a shortcut for this on Windows[cite: 3110]. A successful connection shows a "201 Service ready" message[cite: 3111, 3112].

### 3.9 Enter Commands
Commands are single lines of text terminated by Enter/Return[cite: 3120]. C-Gate sends a response for each command, starting with a 3-digit code[cite: 3120, 3122].
* Example: `noop` command returns `200 OK.`[cite: 3121, 3125].

### 3.12 Explore the Network
* **`tree <network_address>`**: Lists network information, including units, applications, and groups[cite: 3147, 3148, 3151, 3153].
* **`treexml <network_address>`**: Provides similar information in XML format for easier parsing by applications[cite: 3151].

### 3.13 Operation (Lighting Example)
* C-Bus Applications (like Lighting, App 56) group commands[cite: 3158, 3159].
* Lighting uses network variables called **Groups** (addresses 0-254) with values 0 (off) to 255 (on)[cite: 3160, 3161, 3162].
* **Commands**:
    * `on <address>`: Sets group level to 255[cite: 3165].
    * `off <address>`: Sets group level to 0[cite: 3165].
    * `ramp <address> <level> [time]`: Sets group level to 0-255, optionally over a time period (e.g., `2m`)[cite: 3165, 3172].
    * `get <address> level`: Retrieves the current level of a group[cite: 3171].
* **Addressing**: Can use full `//PROJECT/NETWORK/APP/GROUP` or relative `NETWORK/APP/GROUP` if a project context is set via `project use`[cite: 3169, 3170].

## 4. Reference

### 4.3 Command and Monitoring Interfaces
C-Gate provides several TCP/IP interfaces (Telnet-style, optional SSL):
* **Command Interface (Port 20023 / SSL 20123)**: Primary interface for issuing commands and getting responses. Can also deliver events using the `EVENT` command[cite: 3256, 3258, 3259, 3260].
* **Event Interface (Port 20024 / SSL 20124)**: Provides a continuous stream of events occurring on the server[cite: 3262, 3264].
* **Status Change Port (SCP) (Port 20025 / SSL 20125)**: Streams events resulting from status changes in C-Bus Applications (e.g., lighting on/off/ramp) formatted as commands/comments[cite: 3266, 3267, 3268].
* **Config Change Port (CCP) (Port 20026 / SSL 20126)**: Streams configuration change events (e.g., unit addition/deletion, sync states)[cite: 3270, 3271].

### 4.3.1 Command Interface
* Can be accessed via the C-Gate console window (if not running as a service) or TCP/IP (Telnet)[cite: 3273, 3275, 3277, 3282].
* TCP/IP connection typically uses port 20023[cite: 3284].
* Successful connection returns `201 Service ready...`[cite: 3285].
* Commands are single lines, terminated by CRLF[cite: 3290]. Responses are also line-based[cite: 3290].

#### 4.3.1.4 Commands
* **Syntax**: `action-verb [ parameters ] CRLF`[cite: 3302].
* **Object Addressing**:
    * Uses a path structure separated by `/` (e.g., `//PROJECT/NETWORK/APP/GROUP`)[cite: 3317].
    * Physical addressing uses `p/` (e.g., `//HOME/p/57/15` for unit 15 on network 57)[cite: 3326, 3327].
    * Application/Group addressing (e.g., `2/56/12` for group 12 in app 56 on network 2)[cite: 3326].
    * Wildcards (`*`) can be used in the last part (e.g., `p/57/*` for all units)[cite: 3327].
    * Object names (e.g., for system objects) can also be used[cite: 3320].
* **Array Filtering**: Syntax `[name=value]` can be used instead of index `[#]` in some commands (like `dbget`) to filter arrays based on field values (e.g., `dbget 254/Unit[Address=207]`)[cite: 3334, 3335, 3336, 3340].
* **Unique Command IDs**:
    * Prefix commands with `[id-string]` (e.g., `[cmd123]noop`). All responses for that command will be prefixed with the same ID[cite: 3346, 3347, 3351, 3363].
    * Prefix with `&` for background processing (e.g., `&[bg1]net sync 254`)[cite: 3357]. Optional priority digit (0-9) can follow `&`[cite: 3353, 3357].
    * Prefix with `*` for verbose output (e.g., `*[vcmd1]tree 254`)[cite: 3361, 3362].

#### 4.3.1.5 C-Gate Response Codes
* Responses start with a 3-digit code[cite: 3371].
* **1xx**: Informational[cite: 3378].
* **2xx**: Successful completion[cite: 3378].
* **3xx**: Object status/information returned[cite: 3378].
* **4xx**: Client-side error (syntax, bad ID, permissions)[cite: 3378].
* **5xx**: Server-side error (internal, network)[cite: 3378].
* **6xx**: Confirmation required (e.g., for `shutdown`)[cite: 3378].
* *(7xx-9xx reserved for events)*

### 4.3.2 Event Interface
* Provides a continuous stream of events[cite: 3262].
* C-Gate connects to a host/port specified in config, or clients connect to C-Gate's event port (default 20024 / SSL 20124)[cite: 3413, 3264].
* Event Format: `YYYYMMDD-HHMMSS[.mmm] <event-code> <object-identifier> <event-info>`[cite: 3417]. Milliseconds optional[cite: 3423].
* Event Codes: 7xx (status), 8xx (medium priority), 9xx (alarms)[cite: 3422].
* **Event Levels**: Controlled globally (`global-event-level`) or per-object (`event-level`). Higher levels include more detail (Level 9 includes debug info)[cite: 3430, 3436, 3437]. Level 5 is typical[cite: 3434]. Level 3 includes object info and critical errors[cite: 3435].
* **Buffering**: Clients must read events promptly to avoid buffer overflow (`###!!! Event buffer overflow...`)[cite: 3426, 3428].

### 4.5 Command Descriptions (Selected API-Relevant Commands)
*(Note: This is a selection. Refer to the manual section 4.5 for the full list and details)*

* **`#` or `//`**: Comment[cite: 3528, 3530].
* **`APIVER [details]`**: Lists API versions for C-Gate components[cite: 3579].
* **`CLOCK DATE|TIME|REQUEST_REFRESH ...`**: Interact with Clock and Timekeeping Application ($DF)[cite: 3656, 3657, 4922].
* **`CONFIG GET|SET|INFO|LOAD|SAVE|OBGET|OBSET|OBRESET ...`**: Manage C-Gate configuration parameters[cite: 3671, 3672].
* **`DBADD|DBADDSAFE|DBCOPY|DBCOPYSAFE|DBCREATE|...|DBSETXML`**: Commands for manipulating the project (tag) database directly[cite: 3706, 3710, 3719, 3730, 3742, 3745, 3750, 3751, 3753, 3754, 3757, 3763, 3770, 3779, 3780, 3790, 3796, 3803, 3807, 3808, 3815, 3821, 3822, 3830, 3834].
* **`DO <object-id> <method-name> [params...]`**: Executes a method on an object[cite: 3839].
* **`ENABLE SET|LABEL|REMOVE ...`**: Interact with Enable Control Application ($CB)[cite: 4935].
* **`EVENT ON|OFF|event-mode`**: Controls event output for the current command session[cite: 3876, 3878].
* **`GET <object-id> [parameter|?|*|??]`**: Retrieves object parameters (Alias: `SHOW`)[cite: 3889, 3891, 3892].
* **`GETSTATE <network-address>`**: Triggers events reporting the current state of network objects[cite: 3895].
* **`HELP [command]`**: Gets command help[cite: 3898].
* **`LIGHTING ON|OFF|RAMP|TERMINATERAMP|LABEL|UNICODELABEL ...`**: Interact with Lighting Application ($38)[cite: 3905, 3906, 3907, 3908, 4783]. (ON/OFF/RAMP/TERMINATERAMP are often used directly without the `LIGHTING` prefix).
* **`LOGIN [user pass]`**: Change access level for the current session[cite: 3942].
* **`LOGOUT`**: Log out of the current access level[cite: 3945].
* **`MEASUREMENT DATA ...`**: Interact with Measurement Application ($E4)[cite: 3947, 4969].
* **`MEDIATRANSPORT ...`**: Interact with Media Transport Control Application ($C0)[cite: 3951, 5028].
* **`NET CREATE|OPEN|CLOSE|SYNC|LIST|PINGU|UNRAVEL...`**: Manage C-Bus networks within C-Gate[cite: 4022, 4023, 4024, 4025, 4026, 4027, 4028, 4029, 4030, 4031, 4032, 4033, 4034, 4035].
* **`NEW <type> <id> [params...]`**: Creates new C-Gate objects (e.g., groups)[cite: 4182, 4183].
* **`NOOP`**: No operation, returns `200 OK` if connection is live[cite: 4186].
* **`OFF <group-address> ["force"]`**: Turns a group off (level 0)[cite: 4191, 4192].
* **`ON <group-address> ["force"]`**: Turns a group on (level 255)[cite: 4197, 4198].
* **`OID`**: Generates a unique Object ID[cite: 4195].
* **`PORT LIST|CNISCAN|PROBE|IFLIST|REFRESH...`**: Manage and discover communication ports (Serial, CNI)[cite: 4200, 4201, 4202, 4203, 4204].
* **`PROJECT LOAD|SAVE|LIST|DIR|NEW|START|STOP|USE...`**: Manage C-Gate projects[cite: 4258, 4259, 4260, 4261, 4262, 4263, 4264, 4265, 4266, 4267].
* **`QUIT` or `EXIT`**: Closes the current command connection[cite: 4337, 4338].
* **`RAMP <group-address> <level> [time] ["force"]`**: Ramps group to a level (0-255 or 0%-100%) over an optional time[cite: 4339, 4340, 4341, 4342].
* **`RUN <filename> [QUIET]`**: Executes commands from a macro file[cite: 4353, 4354].
* **`SCENE PLAY|RECORD <set> <scene>`**: Interact with the Scene Module[cite: 4356].
* **`SECURITY ARM|STATUS_REQUEST|TAMPER...`**: Interact with Security Application ($D0)[cite: 4359, 4360, 4361, 4362, 4363, 4364, 4365, 5067].
* **`SESSION_ID [ALL|TAG]`**: Gets current session ID or all sessions, or tags the current session[cite: 4390, 4393, 4401].
* **`SET <object-id> <parameter> <value>`**: Sets an object parameter[cite: 4402, 4403].
* **`SHOW ...`**: Deprecated alias for `GET`[cite: 4408].
* **`SHUTDOWN`**: Shuts down the C-Gate server (requires `CONFIRM`)[cite: 4409, 4411].
* **`STOP <command-id>`**: Stops a backgrounded command[cite: 4422].
* **`TEMPERATURE BROADCAST ...`**: Interact with Temperature Broadcast Application ($19)[cite: 4445, 4446, 5230].
* **`TERMINATERAMP <group-address> ["force"]`**: Stops a ramp operation on a group[cite: 4450, 4451].
* **`TREE <network-address>`**: Displays a human-readable tree of a network[cite: 4472].
* **`TREEXML <network-address> [...]`**: Returns network structure as XML[cite: 4474].
* **`TREEXMLDETAIL <network-address> [...]`**: Like `TREEXML` but includes unit State and OnlineStatus[cite: 4478, 4479].
* **`TRIGGER EVENT|LABEL|UNICODELABEL ...`**: Interact with Trigger Control Application ($CA)[cite: 4484, 4485, 4489, 4497, 4504, 4509].

### 4.6 Configuration Parameters
*(Refer to the manual section 4.6.4 for a full list)*
C-Gate behaviour is controlled by parameters stored hierarchically (Internal -> Global File -> Project DB -> Network DB)[cite: 4518, 4519]. Lower levels override higher ones[cite: 4518].
* **Scope**: Parameters can be `global`, `project`, or `network` level[cite: 4531, 4532, 4534, 4536].
* **Management**: Use `CONFIG` commands (especially `OBGET`, `OBSET`, `OBRESET`) to view and manage parameters at different scopes[cite: 4546, 4547].
* **Key Parameters (Examples)**:
    * `command-port`: Port for Command Interface (default 20023)[cite: 4594].
    * `event-port`: Port for Event Interface (default 20024)[cite: 4625].
    * `sync-time`: Interval for background network sync (default 3600s)[cite: 4705].
    * `project.start`: Space-separated list of projects to auto-start[cite: 4684].
    * `access-control-file`: Name of the access control file (default access.txt)[cite: 4554].
    * `accept-connections-from`: IP addresses allowed to connect (default 'all')[cite: 4550, 4551].

### 4.7 C-Bus Applications (Overview)
C-Gate models different C-Bus functionalities as Applications, each with a specific C-Bus address. Commands and events are often namespaced by the application's short name (e.g., `lighting`, `security`, `trigger`). Key applications relevant to API interaction include:
* **Lighting ($38)**: ON, OFF, RAMP commands for groups[cite: 4783].
* **Clock and Timekeeping ($DF)**: Set/get network time[cite: 4920].
* **Enable Control ($CB)**: General purpose binary/level control[cite: 4935].
* **Measurement ($E4)**: Reading measurement data[cite: 4965].
* **Security ($D0)**: Arm/disarm, status requests, zone info[cite: 5066].
* **Temperature Broadcast ($19)**: Reading/sending temperature values[cite: 5229].
* **Trigger Control ($CA)**: Sending trigger events[cite: 5262].
* *(Refer to manual section 4.7 for detailed events and commands for each application)*

### 4.12 Object Overview
C-Gate uses an object model. Objects (like networks, units, groups, applications) have parameters (view with `GET`, modify with `SET`) and methods (execute with `DO`)[cite: 3307, 3308, 3309, 3310, 5506, 5507, 5508].
* Use `get <object> ?` for parameter list[cite: 3891].
* Use `get <object> *` for all parameter values[cite: 3892].
* Use `get <object> ??` for parameter list with descriptions[cite: 3893].

*(Refer to manual section 4.12 for details on specific object types like CBusNetwork, CBusUnit, CBusGroup etc.)*