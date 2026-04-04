namespace sample

open System

module Program =
    [<STAThread>]
    [<EntryPoint>]
    let main _ =
        let app = App()
        app.InitializeComponent()

        let window = MainWindow()
        window.InitializeComponent()

        app.Run(window)
